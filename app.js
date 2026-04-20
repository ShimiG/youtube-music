require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet'); 
const rateLimit = require('express-rate-limit'); 

const historyController = require('./controllers/historyController');
const streamingController = require('./controllers/streamingController');
// --- Custom Playlist Routes ---
const playlistController = require('./controllers/playlistController');



const searchRoute = require('./routes/search');
const authRoutes = require('./routes/auth');
const playlistRoutes = require('./routes/playlist');

const app = express();

app.use(express.json()); 
app.use(cors());         

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
        }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    noSniff: true,
    xssFilter: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' }
}));

app.use(express.static('public'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again later."
});


const validateVideoId = (req, res, next) => {

    const videoId = req.query.videoId || req.body.videoId;


    const isValid = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId);

    if (!isValid) {
        console.error(`Blocked malicious/invalid request: ${videoId}`);
        return res.status(400).send("Invalid Video ID");
    }
    
    next();
};

const jwtAuth = require('./middleware/jwtAuth'); // Add JWT middleware

app.get('/test', (req, res) => {
    res.send("Server is working!");
});

app.use('/search', searchRoute);
app.use('/playlist', playlistRoutes);
app.use('/auth', authRoutes);
app.post('/history', jwtAuth, historyController.logHistory);
app.get('/history', jwtAuth, historyController.getHistory);
app.get('/play', limiter, validateVideoId, streamingController);
app.get('/api/custom-playlists', playlistController.getCustomPlaylists);
app.post('/api/custom-playlists', playlistController.createCustomPlaylist);
app.get('/api/custom-playlists/:id/tracks', playlistController.getCustomPlaylistTracks);
app.post('/api/custom-playlists/:id/tracks', playlistController.addTrackToPlaylist);
app.get('/', (req, res) => {
    res.json({ 
        status: "Running", 
        message: "Music Backend is active",
        timestamp: new Date()
    });
});
module.exports = app;