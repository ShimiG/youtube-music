const express = require('express');
const initDB = require('./config/db');
const cors = require('cors');
const { google } = require('googleapis');
const { spawn, execFile } = require('child_process');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());


// --- IMPORT MIDDLEWARE ---
const authMiddleware = require('./middleware/auth');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// --- AUTHENTICATION ROUTES ---
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/youtube.readonly',
                'https://www.googleapis.com/auth/userinfo.profile',
                'https://www.googleapis.com/auth/userinfo.email']
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        res.redirect(`http://localhost:5173?access_token=${tokens.access_token}`);
    } catch (error) {
        console.error('Error retrieving access token', error);
        res.status(500).send("Authentication failed");
    }
});

// --- SEARCH ENDPOINT ---
const parseDuration = (isoDuration) => {
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = isoDuration.match(regex);
    if (!matches) return 0;
    
    const hours = parseInt(matches[1] || 0);
    const minutes = parseInt(matches[2] || 0);
    const seconds = parseInt(matches[3] || 0);
    
    return (hours * 3600) + (minutes * 60) + seconds;
};

app.get('/search', authMiddleware, async (req, res) => {
    const query = req.query.q;
    const token = req.oauthToken; 

    if (!token) return res.status(401).send("Unauthorized: No token provided");

    try {
        oauth2Client.setCredentials({ access_token: token });
        
        const youtube = google.youtube({
            version: 'v3',
            auth: oauth2Client
        });

        const searchResponse = await youtube.search.list({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: 30
        });

        const items = searchResponse.data.items;
        if (!items || items.length === 0) return res.json([]);

        const videoIds = items.map(item => item.id.videoId).join(',');

        const videosResponse = await youtube.videos.list({
            part: 'contentDetails,snippet',
            id: videoIds
        });


        const cleanResults = videosResponse.data.items.map(video => ({
            id: video.id,
            title: video.snippet.title,
            channelTitle: video.snippet.channelTitle,
            thumbnail: video.snippet.thumbnails.default.url,
            duration: parseDuration(video.contentDetails.duration) 
        }));

        res.json(cleanResults);

    } catch (error) {
        console.error('Search API Error:', error);
        
        if (error.message && (error.message.includes('Invalid Credentials') || error.code === 401)) {
            return res.status(401).json({ error: "Token expired or invalid" });
        }
        
        res.status(500).send(error.message);
    }
});

app.get('/playlists', authMiddleware, async (req, res) => {
    const token = req.oauthToken;
    if (!token) return res.status(401).send("Unauthorized");

    try {
        oauth2Client.setCredentials({ access_token: token });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        const response = await youtube.playlists.list({
            part: 'snippet,contentDetails',
            mine: true,
            maxResults: 50
        });

        const playlists = response.data.items.map(pl => ({
            id: pl.id,
            title: pl.snippet.title,
            thumbnail: pl.snippet.thumbnails?.default?.url || 'https://via.placeholder.com/80',
            itemCount: pl.contentDetails.itemCount 
        }));

        res.json(playlists); 
    } catch (error) {
        console.error('Playlists API Error:', error);
        res.status(500).send(error.message);
    }
});


app.get('/playlists/:id/tracks', authMiddleware, async (req, res) => {
    const token = req.oauthToken;
    const playlistId = req.params.id;
    if (!token) return res.status(401).send("Unauthorized");

    try {
        oauth2Client.setCredentials({ access_token: token });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        const itemsRes = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId,
            maxResults: 50
        });

        const videoIds = itemsRes.data.items.map(item => item.contentDetails.videoId).join(',');
        if (!videoIds) return res.json([]);

        const videosRes = await youtube.videos.list({
            part: 'contentDetails,snippet',
            id: videoIds
        });

        const cleanTracks = videosRes.data.items.map(video => ({
            id: video.id,
            title: video.snippet.title,
            channelTitle: video.snippet.channelTitle,
            thumbnail: video.snippet.thumbnails?.default?.url || 'https://via.placeholder.com/80',
            duration: parseDuration(video.contentDetails.duration) 
        }));

        res.json(cleanTracks);
    } catch (error) {
        console.error('Playlist Tracks API Error:', error);
        res.status(500).send(error.message);
    }
});

// --- AUDIO STREAMING ENDPOINT ---

app.get('/stream', (req, res) => {
    const videoId = req.query.videoId;
    const seekTime = Math.floor(Number(req.query.seek || 0)); 

    if (!videoId) return res.status(400).send("Missing videoId");

    console.log(`\nSTREAM REQUEST: Video ${videoId} | Seek: ${seekTime}s`);

    const isWindows = process.platform === 'win32';
    const ytDlpPath = path.join(__dirname, 'bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos');


    const args = [
        '-g',                            
        `https://www.youtube.com/watch?v=${videoId}`
    ];

    execFile(ytDlpPath, args, (error, stdout, stderr) => {
        if (error) {
            console.error("Scout Error:", stderr);
            return res.status(500).send("Could not find audio URL");
        }   

        const audioUrl = stdout.trim();
        if (!audioUrl) return res.status(500).send("No URL found");

        const ffmpegArgs = [
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-ss', seekTime.toString(),      
            '-i', audioUrl,      
            '-vn',
            '-c:a', 'aac',        
            '-b:a', '128k',         
            '-f', 'adts',       
            '-'                  
        ];

        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

        res.setHeader('Content-Type', 'audio/aac');
        res.setHeader('Transfer-Encoding', 'chunked');
        
        ffmpegProcess.stdout.pipe(res);
        
        ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('Error') || msg.includes('Invalid')) {
                console.error(`FFmpeg Error: ${msg}`);
            }
        });

        req.on('close', () => {
            console.log("Client disconnected. Killing FFmpeg stream.");
            ffmpegProcess.kill('SIGKILL');
        });
    });
});

// --- LOG LISTENING HISTORY ---
app.post('/history', async (req, res) => {
    const db = req.app.locals.db; 
    const googleId = req.headers['x-google-id']; 
    const { trackId, title, artist, thumbnail, email, displayName } = req.body;

    if (!googleId || !trackId) return res.status(400).send("Missing user or track data");

    try {
        await db.run(
            `INSERT OR IGNORE INTO users (oauth_id, display_name, email, platform) VALUES (?, ?, ?, 'google')`,
            [googleId, displayName || 'User', email || '']
        );
        const user = await db.get(`SELECT id FROM users WHERE oauth_id = ?`, [googleId]);
        await db.run(`DELETE FROM history WHERE user_id = ? AND track_id = ?`, [user.id, trackId]);
        await db.run(
            `INSERT INTO history (user_id, track_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)`,
            [user.id, trackId, title, artist, thumbnail]
        );
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
});
app.get('/history', async (req, res) => {
    const db = req.app.locals.db;
    const googleId = req.headers['x-google-id']; 

    if (!googleId) return res.status(401).send("Unauthorized: Missing Google ID");

    try {
        const history = await db.all(`
            SELECT 
                h.track_id as id, 
                h.title, 
                h.artist as channelTitle, 
                h.thumbnail as image
            FROM history h
            JOIN users u ON h.user_id = u.id
            WHERE u.oauth_id = ?
            ORDER BY h.played_at DESC
            LIMIT 50
        `, [googleId]);
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
});

initDB().then(db => {
    app.locals.db = db; 
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        });
}).catch(err => {
    console.error('Failed to initialize database:', err);
});