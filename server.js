const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const PORT = 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// --- AUTHENTICATION ROUTES ---
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/youtube.readonly']
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
app.get('/search', async (req, res) => {
    const query = req.query.q;
    const token = req.headers.authorization?.split(' ')[1]; 

    if (!token) return res.status(401).send("Unauthorized: No token provided");

    try {
        oauth2Client.setCredentials({ access_token: token });
        
        const youtube = google.youtube({
            version: 'v3',
            auth: oauth2Client
        });

        const response = await youtube.search.list({
            part: 'snippet',
            q: query,
            type: 'video',
            maxResults: 20
        });

        res.json(response.data);
    } catch (error) {
        console.error('Search API Error:', error);
        res.status(500).send(error.message);
    }
});

// --- AUDIO STREAMING ENDPOINT (THE MISSING PART) ---
app.get('/stream', (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId) return res.status(400).send("Missing videoId");

    // 1. Detect OS
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos';

    // 2. Build Path to 'bin' folder
    const ytDlpPath = path.join(__dirname, 'bin', binaryName);

    console.log(`🎤 Starting stream for: ${videoId}`);
    console.log(`📂 Using binary: ${ytDlpPath}`);
    
    // 3. Spawn Process
const child = spawn(ytDlpPath, [
        '-f', 'bestaudio[ext=m4a]/bestaudio', 
        '--force-ipv4',
        '--buffer-size', '16K',
        '-o', '-', 
        `https://www.youtube.com/watch?v=${videoId}`
    ]);
    res.setHeader('Content-Type', 'audio/mpeg');

    child.stdout.pipe(res);

    // Error handling
    child.stderr.on('data', (data) => {
        // console.error(`yt-dlp stderr: ${data}`); // Uncomment to debug
    });

    child.on('error', (err) => {
        console.error("Failed to start yt-dlp:", err);
        if (!res.headersSent) res.status(500).send("Streamer error");
    });

    // Cleanup: Kill the process if client disconnects 
    req.on('close', () => {
        child.kill(); 
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});