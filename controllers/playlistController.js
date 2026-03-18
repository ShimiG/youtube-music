
const { google } = require('googleapis');

    const getYouTubeClient = (token) => {
        if (!token) throw new Error("No token provided");
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: token });
        return google.youtube({ version: 'v3', auth: oauth2Client });
    };

    const getYouTubeLikes = async (req, res) => {
       try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token" });
        
        const token = authHeader.replace('Bearer ', '');
            const youtube = getYouTubeClient(token);

            const response = await youtube.videos.list({
                part: 'snippet,contentDetails,statistics',
                myRating: 'like',
                maxResults: 50 
            });

            const musicVideos = response.data.items.filter(video => 
                video.snippet.categoryId === '10'
            );

            const normalizedItems = musicVideos.map(video => ({
                ...video,
                snippet: {
                    ...video.snippet,
                    resourceId: { videoId: video.id } 
                }
            }));

            res.json(normalizedItems);

        } catch (error) {
            console.error("Fetch Likes Error:", error.message);
            res.status(500).json({ error: "Failed to fetch liked videos." });
        }
    };

const likeVideo = async (req, res) => {
    console.log("[Backend] Received like request...");

    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) {
            console.error("[Backend] Error: No token provided");
            return res.status(401).json({ error: "No token" });
        }
        
        const token = authHeader.replace('Bearer ', '');
        
        const { videoId } = req.body; 
        console.log(`[Backend] Liking video ID: ${videoId}`);

        if (!videoId) {
            return res.status(400).json({ error: "Missing videoId" });
        }

        const youtube = getYouTubeClient(token);
        await youtube.videos.rate({
            id: videoId,
            rating: 'like'
        });

        console.log("[Backend] Success! Video liked.");
        res.sendStatus(200);

    } catch (error) {
        console.error("[Backend] Google API Error:", error.message);
        res.status(500).json({ error: "Could not like video" });
    }
};
const getUserPlaylists = async (req, res) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token provided." });

        const token = authHeader.replace('Bearer ', '');

        const youtube = getYouTubeClient(token);

        const response = await youtube.playlists.list({
            part: 'snippet,contentDetails',
            mine: true,
            maxResults: 50
        });

        res.json(response.data.items);
    } catch (error) {
        console.error("Fetch Playlists Error:", error.message);
        
        if (error.code === 401 || error.code === 403) {
            return res.status(401).json({ error: "Token expired or invalid" });
        }
        
        res.status(500).json({ error: "Failed to fetch playlists." });
    }
};


const getPlaylistTracks = async (req, res) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token" });
        const token = authHeader.replace('Bearer ', '');

        const { id } = req.params;
        if (!id) return res.status(400).json({ error: "Missing Playlist ID" });

        const youtube = getYouTubeClient(token);

        const response = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId: id, 
            maxResults: 50
        });

        const tracks = response.data.items.map(item => ({
            id: item.snippet.resourceId.videoId,
            title: item.snippet.title,
            artist: item.snippet.videoOwnerChannelTitle,
            image: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
            source: 'youtube'
        }));

        res.json(tracks);
    } catch (error) {
        console.error("Fetch Tracks Error:", error.message);
        res.status(500).json({ error: "Failed to fetch tracks" });
    }
};

    const addTrackToPlaylist = async (req, res) => {
        const db = req.app.locals.db;
        const { playlistId } = req.params;
        const { sourceName, externalId, title, artist, thumbnail } = req.body;

        try {
            const source = await db.get(`SELECT id FROM sources WHERE name = ?`, [sourceName]);
            if (!source) return res.status(400).json({ error: "Invalid source" });
            await db.run(
                `INSERT OR IGNORE INTO tracks (source_id, external_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
                [source.id, externalId, title, artist, thumbnail]
            );
            const track = await db.get(`SELECT id FROM tracks WHERE source_id = ? AND external_id = ?`, [source.id, externalId]);

            await db.run(`INSERT INTO playlist_tracks (playlist_id, track_id) VALUES (?, ?)`, [playlistId, track.id]);
            
            res.status(201).json({ success: true, message: "Track added to playlist" });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    };

    const createCustomPlaylist = async (req, res) => {
    const db = req.app.locals.db;
    const userId = req.headers['x-user-id']; 
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { name, thumbnail } = req.body;

    try {
        const user = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!user) return res.status(404).json({ error: "User not found in DB" });

        const result = await db.run(
            `INSERT INTO playlists (user_id, name, thumbnail) VALUES (?, ?, ?)`, 
            [user.id, name, thumbnail || 'https://via.placeholder.com/150']
        );
        res.status(201).json({ id: result.lastID, name, thumbnail });
    } catch (error) {
        console.error("Create Playlist Error:", error.message);
        res.status(500).json({ error: "Failed to create playlist" });
    }
};

const getCustomPlaylists = async (req, res) => {
    const db = req.app.locals.db;
    const userId = req.headers['x-user-id']; 
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        const playlists = await db.all(`
            SELECT p.id, p.name, p.thumbnail, COUNT(pt.track_id) as itemCount 
            FROM playlists p
            LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
            WHERE p.user_id = ?
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `, [userId]);
        
        res.json(playlists);
    } catch (error) {
        console.error("Fetch Custom Playlists Error:", error.message);
        res.status(500).json({ error: "Failed to fetch custom playlists" });
    }
};

const getCustomPlaylistTracks = async (req, res) => {
    const db = req.app.locals.db;
    const { playlistId } = req.params;

    try {
        const tracks = await db.all(`
            SELECT 
                t.external_id as id, t.title, t.artist as channelTitle, t.thumbnail as image, s.name as source
            FROM playlist_tracks pt
            JOIN tracks t ON pt.track_id = t.id
            JOIN sources s ON t.source_id = s.id
            WHERE pt.playlist_id = ?
            ORDER BY pt.sort_order ASC, pt.added_at ASC
        `, [playlistId]);
        
        res.json(tracks);
    } catch (error) {
        console.error("Fetch Custom Tracks Error:", error.message);
        res.status(500).json({ error: "Failed to fetch custom tracks" });
    }
};

module.exports = { 
    getYouTubeLikes,
    likeVideo,
    getUserPlaylists, 
    getPlaylistTracks,
    addTrackToPlaylist,
    createCustomPlaylist,
    getCustomPlaylists,
    getCustomPlaylistTracks
};

