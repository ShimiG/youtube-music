const { getYouTubeClient } = require('./youtubeClient');
const { sendSourceError } = require('../services/errors');
const { cleanTrackMeta } = require('../services/trackMeta');

// --- YouTube-backed endpoints (auth via sourceToken('youtube') -> req.sourceToken) ---

const getYouTubeLikes = async (req, res, next) => {
    try {
        const youtube = getYouTubeClient(req.sourceToken);
        const response = await youtube.videos.list({
            part: 'snippet,contentDetails,statistics',
            myRating: 'like',
            maxResults: 50
        });

        const musicVideos = response.data.items.filter(video => video.snippet.categoryId === '10');
        const normalizedItems = musicVideos.map(video => ({
            ...video,
            snippet: { ...video.snippet, resourceId: { videoId: video.id } }
        }));

        res.json(normalizedItems);
    } catch (error) {
        if (error.code === 401 || error.code === 403) {
            return sendSourceError(res, 'SOURCE_TOKEN_EXPIRED', 'youtube');
        }
        console.error('Fetch Likes Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch liked videos.' });
    }
};

const likeVideo = async (req, res, next) => {
    const { videoId } = req.body || {};
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    try {
        const youtube = getYouTubeClient(req.sourceToken);
        await youtube.videos.rate({ id: videoId, rating: 'like' });
        res.sendStatus(200);
    } catch (error) {
        if (error.code === 401 || error.code === 403) {
            return sendSourceError(res, 'SOURCE_TOKEN_EXPIRED', 'youtube');
        }
        console.error('Like Video Error:', error.message);
        res.status(500).json({ error: 'Could not like video' });
    }
};

const getUserPlaylists = async (req, res, next) => {
    try {
        const youtube = getYouTubeClient(req.sourceToken);
        const response = await youtube.playlists.list({
            part: 'snippet,contentDetails',
            mine: true,
            maxResults: 50
        });
        res.json(response.data.items);
    } catch (error) {
        if (error.code === 401 || error.code === 403) {
            return sendSourceError(res, 'SOURCE_TOKEN_EXPIRED', 'youtube');
        }
        console.error('Fetch Playlists Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch playlists.' });
    }
};

const getPlaylistTracks = async (req, res, next) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing Playlist ID' });

    try {
        const youtube = getYouTubeClient(req.sourceToken);
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
        if (error.code === 401 || error.code === 403) {
            return sendSourceError(res, 'SOURCE_TOKEN_EXPIRED', 'youtube');
        }
        console.error('Fetch Tracks Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch tracks' });
    }
};

// --- Local custom playlists (auth via requireAuth middleware -> req.userId) ---

const MAX_TRACK_TEXT = 300;

const createCustomPlaylist = async (req, res, next) => {
    const db = req.app.locals.db;
    const { name, thumbnail } = req.body || {};

    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
        return res.status(400).json({ error: 'Playlist name is required (max 120 chars)' });
    }

    try {
        const result = await db.run(
            `INSERT INTO playlists (user_id, name, thumbnail) VALUES (?, ?, ?)`,
            [req.userId, name.trim(), (typeof thumbnail === 'string' ? thumbnail : null)]
        );
        res.status(201).json({ id: result.lastID, name: name.trim(), thumbnail });
    } catch (error) {
        next(error);
    }
};

const getCustomPlaylists = async (req, res, next) => {
    const db = req.app.locals.db;
    try {
        const playlists = await db.all(`
            SELECT p.id, p.name, p.thumbnail, COUNT(pt.track_id) as itemCount
            FROM playlists p
            LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
            WHERE p.user_id = ?
            GROUP BY p.id
            ORDER BY p.created_at DESC
        `, [req.userId]);
        res.json(playlists);
    } catch (error) {
        next(error);
    }
};

// Confirms the playlist exists AND belongs to the logged-in user before any
// read/write, so one user cannot touch another user's playlist by guessing its id.
const assertPlaylistOwnership = async (db, playlistId, userId) => {
    const playlist = await db.get(
        `SELECT id FROM playlists WHERE id = ? AND user_id = ?`,
        [playlistId, userId]
    );
    return Boolean(playlist);
};

const addTrackToPlaylist = async (req, res, next) => {
    const db = req.app.locals.db;
    const { playlistId } = req.params;
    const { sourceName, externalId, title, artist, thumbnail } = req.body || {};

    const meta = cleanTrackMeta({ title, artist, thumbnail });
    if (!externalId || typeof externalId !== 'string' || externalId.length > 200 || !meta) {
        return res.status(400).json({ error: 'externalId and title are required' });
    }
    // These strings are parsed by the match engine later; keep them within
    // the same bound the match API enforces.
    if (title.length > MAX_TRACK_TEXT || (artist !== undefined && artist !== null && (typeof artist !== 'string' || artist.length > MAX_TRACK_TEXT))) {
        return res.status(400).json({ error: `title and artist must be at most ${MAX_TRACK_TEXT} characters` });
    }

    try {
        if (!(await assertPlaylistOwnership(db, playlistId, req.userId))) {
            return res.status(404).json({ error: 'Playlist not found' });
        }

        const source = await db.get(`SELECT id FROM sources WHERE name = ?`, [sourceName]);
        if (!source) return res.status(400).json({ error: 'Invalid source' });

        await db.run(
            `INSERT OR IGNORE INTO tracks (source_id, external_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [source.id, externalId, meta.title, meta.artist, meta.thumbnail]
        );
        const track = await db.get(
            `SELECT id FROM tracks WHERE source_id = ? AND external_id = ?`,
            [source.id, externalId]
        );

        // Adding the same track twice is a no-op, not a duplicate row.
        const existing = await db.get(
            `SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`,
            [playlistId, track.id]
        );
        if (existing) {
            return res.status(200).json({ success: true, alreadyInPlaylist: true, message: 'Track is already in the playlist' });
        }

        await db.run(
            `INSERT INTO playlist_tracks (playlist_id, track_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [playlistId, track.id, meta.title, meta.artist, meta.thumbnail]
        );
        res.status(201).json({ success: true, message: 'Track added to playlist' });
    } catch (error) {
        next(error);
    }
};

const getCustomPlaylistTracks = async (req, res, next) => {
    const db = req.app.locals.db;
    const { playlistId } = req.params;

    try {
        if (!(await assertPlaylistOwnership(db, playlistId, req.userId))) {
            return res.status(404).json({ error: 'Playlist not found' });
        }

        const tracks = await db.all(`
            SELECT
                t.external_id as id,
                COALESCE(pt.title, t.title) as title,
                COALESCE(pt.artist, t.artist) as channelTitle,
                CASE WHEN pt.title IS NOT NULL THEN pt.thumbnail ELSE t.thumbnail END as image,
                s.name as source
            FROM playlist_tracks pt
            JOIN tracks t ON pt.track_id = t.id
            JOIN sources s ON t.source_id = s.id
            WHERE pt.playlist_id = ?
            ORDER BY pt.sort_order ASC
        `, [playlistId]);
        res.json(tracks);
    } catch (error) {
        next(error);
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
