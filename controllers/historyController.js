const logHistory = async (req, res) => {
    const db = req.app.locals.db; 
    const userId = req.userId; // From verified JWT token
    const userEmail = req.userEmail; // From verified JWT token
    const { trackId, title, artist, thumbnail } = req.body;
    const sourceName = 'youtube'; // Defaulting to youtube

    if (!userId || !trackId) return res.status(400).send("Missing user or track data");

    try {
        // User already authenticated via JWT, get from verified token
        const user = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!user) return res.status(401).json({ error: 'User not found in session' });
        
        const source = await db.get(`SELECT id FROM sources WHERE name = ?`, [sourceName]);

        await db.run(
            `INSERT OR IGNORE INTO tracks (source_id, external_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [source.id, trackId, title, artist, thumbnail]
        );
        const track = await db.get(`SELECT id FROM tracks WHERE source_id = ? AND external_id = ?`, [source.id, trackId]);

        await db.run(`DELETE FROM history WHERE user_id = ? AND track_id = ?`, [user.id, track.id]);
        
        await db.run(`INSERT INTO history (user_id, track_id) VALUES (?, ?)`, [user.id, track.id]);

        await db.run(`
            DELETE FROM history 
            WHERE user_id = ? AND id NOT IN (
                SELECT id FROM history WHERE user_id = ? ORDER BY played_at DESC LIMIT 50
            )
        `, [user.id, user.id]);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('History API Error:', error);
        res.status(500).send("Failed to save history");
    }
};

const getHistory = async (req, res) => {
    const db = req.app.locals.db;
    const userId = req.userId; // From verified JWT token

    if (!userId) return res.status(401).json({ error: 'Unauthorized: Missing authentication' });

    try {
        // Verify user exists
        const user = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!user) return res.status(401).json({ error: 'User not found' });

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
            JOIN users u ON h.user_id = u.id
            WHERE u.id = ?
            ORDER BY h.played_at DESC
            LIMIT 50
        `, [googleId]);

        // Filter duplicates
        const uniqueHistory = [];
        const seenIds = new Set();
        for (const track of history) {
            if (!seenIds.has(track.id)) {
                uniqueHistory.push(track);
                seenIds.add(track.id);
            }
        }

        res.json(uniqueHistory);
    } catch (error) {
        console.error('Fetch History Error:', error);
        res.status(500).send("Failed to fetch history");
    }
};

module.exports = { logHistory, getHistory };