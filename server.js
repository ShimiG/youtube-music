const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { spawn, execFile } = require('child_process');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const authMiddleware = require('./middleware/auth');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

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


app.get('/stream', (req, res) => {
    const videoId = req.query.videoId;
    const seekTime = req.query.seek || '0';

    if (!videoId) return res.status(400).send("Missing videoId");

    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos';
    const ytDlpPath = path.join(__dirname, 'bin', binaryName);

    const args = [
        '-g',
        '-f', 'bestaudio[ext=m4a]',
        `https://www.youtube.com/watch?v=${videoId}`
    ];

    execFile(ytDlpPath, args, (error, stdout, stderr) => {
        if (error) {
            console.error("Scout Error:", error);
            return res.status(500).send("Scout failed");
        }

        const audioUrl = stdout.trim();
        if (!audioUrl) return res.status(500).send("No URL found");

        const ffmpegArgs = [
            '-ss', seekTime,      
            '-i', audioUrl,      
            '-c:a', 'aac',        
            '-b:a', '128k',         
            '-f', 'adts',       
            '-'                  
        ];

        const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

        res.setHeader('Content-Type', 'audio/aac');
        ffmpegProcess.stdout.pipe(res);
        

        ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('Error') || msg.includes('Invalid')) {
                console.error(`🔴 FFmpeg Error: ${msg}`);
            }
        });

        req.on('close', () => {
            ffmpegProcess.kill();
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});