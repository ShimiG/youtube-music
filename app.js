require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet'); // 1. Secure Headers
const rateLimit = require('express-rate-limit'); // 2. Rate Limiting

// Import Controller
const { streamAudio } = require('./controllers/playController');

// Import Routes
const searchRoute = require('./routes/search');
const authRoutes = require('./routes/auth');
const playlistRoutes = require('./routes/playlist');

const app = express();

// --- MIDDLEWARE ---
app.use(express.json()); 
app.use(cors());         

// 1. SECURITY: Secure Headers (Helmet)
// This automatically sets HTTP headers to block common web attacks
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for now to avoid breaking YouTube images/scripts
}));

app.use(express.static('public'));

// 2. SECURITY: Rate Limiting
// Only allow 100 requests per 15 minutes per IP to prevent crashing the server
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: "Too many requests from this IP, please try again later."
});

// 3. SECURITY: Input Validation Middleware
// This checks the ID *before* it ever reaches your streamAudio controller
const validateVideoId = (req, res, next) => {
    // Check both query params (GET) and body (POST) just in case
    const videoId = req.query.videoId || req.body.videoId;

    // The Regex: Exactly 11 characters, only alphanumeric, dashes, or underscores.
    const isValid = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId);

    if (!isValid) {
        console.error(`Blocked malicious/invalid request: ${videoId}`);
        return res.status(400).send("Invalid Video ID");
    }
    
    // If valid, proceed to the controller
    next();
};

app.get('/test', (req, res) => {
    console.log("Server is working!");
    res.send("Server is working!");
});

// --- ROUTES ---
app.use('/search', searchRoute);
app.use('/playlist', playlistRoutes);
app.use('/auth', authRoutes);

// --- SECURE AUDIO ROUTE ---
// We chain the security checks BEFORE the controller:
// Limiter -> Validator -> Stream Controller
app.get('/play', limiter, validateVideoId, streamAudio);

// Health Check / Home
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
module.exports = app;