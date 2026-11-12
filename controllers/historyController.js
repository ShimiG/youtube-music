const { cleanTrackMeta } = require('../services/trackMeta');
const cloudSync = require('../services/cloud/sync');

// Identity comes from requireAuth (req.userId), not from a client-supplied
// header. The user row already exists because they logged in, so we only need
// to register the track and record the play.
const logHistory = async (req, res, next) => {
    const db = req.app.locals.db;
    const userId = req.userId;
    const { trackId, title, artist, thumbnail, source } = req.body || {};
    // Tracks carry their source; older clients that omit it are YouTube.
    const sourceName = source === undefined ? 'youtube' : source;

    const meta = cleanTrackMeta({ title, artist, thumbnail });
    if (!trackId || typeof trackId !== 'string' || trackId.length > 200 || !meta) {
        return res.status(400).json({ error: 'Missing track data' });
    }
    if (typeof sourceName !== 'string' || !/^[a-z]{1,32}$/.test(sourceName)) {
        return res.status(400).json({ error: 'Invalid source' });
    }

    try {
        const source = await db.get(`SELECT id FROM sources WHERE name = ?`, [sourceName]);
        if (!source) return res.status(400).json({ error: 'Unknown source' });

        await db.run(
            `INSERT OR IGNORE INTO tracks (source_id, external_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [source.id, trackId, meta.title, meta.artist, meta.thumbnail]
        );
        const track = await db.get(
            `SELECT id FROM tracks WHERE source_id = ? AND external_id = ?`,
            [source.id, trackId]
        );

        // De-dupe: drop any previous play of this track, then record it as newest.
        await db.run(`DELETE FROM history WHERE user_id = ? AND track_id = ?`, [userId, track.id]);
        await db.run(
            `INSERT INTO history (user_id, track_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [userId, track.id, meta.title, meta.artist, meta.thumbnail]
        );

        // Keep only the 50 most recent plays per user.
        await db.run(`
            DELETE FROM history
            WHERE user_id = ? AND id NOT IN (
                SELECT id FROM history WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT 50
            )
        `, [userId, userId]);

        cloudSync.touch(userId); // synced shortly, when this user is linked to the cloud
        res.status(200).json({ success: true });
    } catch (error) {
        next(error);
    }
};

const getHistory = async (req, res, next) => {
    const db = req.app.locals.db;
    const userId = req.userId;

    try {
        const history = await db.all(`
            SELECT
                t.external_id as id,
                COALESCE(h.title, t.title) as title,
                COALESCE(h.artist, t.artist) as channelTitle,
                CASE WHEN h.title IS NOT NULL THEN h.thumbnail ELSE t.thumbnail END as image,
                s.name as source
            FROM history h
            JOIN tracks t ON h.track_id = t.id
            JOIN sources s ON t.source_id = s.id
            WHERE h.user_id = ?
            ORDER BY h.played_at DESC, h.id DESC
            LIMIT 50
        `, [userId]);

        res.json(history);
    } catch (error) {
        next(error);
    }
};

module.exports = { logHistory, getHistory };
