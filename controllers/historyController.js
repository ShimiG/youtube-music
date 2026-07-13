// Identity comes from requireAuth (req.userId), not from a client-supplied
// header. The user row already exists because they logged in, so we only need
// to register the track and record the play.
const logHistory = async (req, res, next) => {
    const db = req.app.locals.db;
    const userId = req.userId;
    const { trackId, title, artist, thumbnail } = req.body || {};
    const sourceName = 'youtube'; // Defaulting to youtube

    if (!trackId || typeof trackId !== 'string' || !title) {
        return res.status(400).json({ error: 'Missing track data' });
    }

    try {
        const source = await db.get(`SELECT id FROM sources WHERE name = ?`, [sourceName]);
        if (!source) return res.status(400).json({ error: 'Unknown source' });

        await db.run(
            `INSERT OR IGNORE INTO tracks (source_id, external_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [source.id, trackId, title, artist || null, thumbnail || null]
        );
        const track = await db.get(
            `SELECT id FROM tracks WHERE source_id = ? AND external_id = ?`,
            [source.id, trackId]
        );

        // De-dupe: drop any previous play of this track, then record it as newest.
        await db.run(`DELETE FROM history WHERE user_id = ? AND track_id = ?`, [userId, track.id]);
        await db.run(`INSERT INTO history (user_id, track_id) VALUES (?, ?)`, [userId, track.id]);

        // Keep only the 50 most recent plays per user.
        await db.run(`
            DELETE FROM history
            WHERE user_id = ? AND id NOT IN (
                SELECT id FROM history WHERE user_id = ? ORDER BY played_at DESC LIMIT 50
            )
        `, [userId, userId]);

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
                t.title,
                t.artist as channelTitle,
                t.thumbnail as image,
                s.name as source
            FROM history h
            JOIN tracks t ON h.track_id = t.id
            JOIN sources s ON t.source_id = s.id
            WHERE h.user_id = ?
            ORDER BY h.played_at DESC
            LIMIT 50
        `, [userId]);

        res.json(history);
    } catch (error) {
        next(error);
    }
};

module.exports = { logHistory, getHistory };
