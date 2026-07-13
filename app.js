const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const requireAuth = require('./middleware/requireAuth');
const googleToken = require('./middleware/googleToken');

const authController = require('./controllers/authController');
const { registerUser, loginUser } = require('./controllers/UserController');
const searchController = require('./controllers/searchController');
const playlistController = require('./controllers/playlistController');
const historyController = require('./controllers/historyController');
const streamingController = require('./controllers/streamingController');
const YouTubeController = require('./controllers/YouTubeController');

const app = express();

// --- Global middleware ---
app.use(helmet());

// Allow only known client origins (dev Vite server + the Tauri webview).
// Configure extra origins via CLIENT_ORIGIN (comma-separated).
const allowedOrigins = new Set([
    'http://localhost:5173',
    'http://localhost:1420',
    'tauri://localhost',
    'https://tauri.localhost',
    ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map(o => o.trim()) : [])
]);
app.use(cors({
    origin: (origin, cb) => {
        // Requests with no Origin (e.g. the native <audio> element, curl) are allowed.
        if (!origin || allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'));
    }
}));

app.use(express.json({ limit: '1mb' }));

// --- Rate limiters ---
// yt-dlp + ffmpeg are expensive, so the media endpoints get their own cap.
const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
// Login/register are brute-force targets, so they get a tighter cap.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// --- Health ---
app.get('/', (req, res) => {
    res.json({ status: 'Running', message: 'Music Backend is active' });
});
app.get('/test', (req, res) => res.send('Server is working!'));

// --- Local account auth ---
app.post('/api/register', authLimiter, registerUser);
app.post('/api/login', authLimiter, loginUser);

// --- Google OAuth (connects a YouTube account to the logged-in user) ---
// The URL endpoint requires our login so the callback can tie the tokens to a
// user; the callback itself is public because Google redirects the bare browser.
app.get('/auth/google/url', requireAuth, authController.getGoogleAuthUrl);
app.get('/auth/google/callback', authController.googleCallback);
app.get('/api/user/connections', requireAuth, authController.getConnections);

// --- YouTube-backed endpoints (our login + the user's stored Google token) ---
app.get('/search', requireAuth, googleToken, searchController.searchTracks);
app.get('/playlists', requireAuth, googleToken, playlistController.getUserPlaylists);
app.get('/playlists/:id/tracks', requireAuth, googleToken, playlistController.getPlaylistTracks);

// --- Media (rate-limited + input-validated; no Bearer header because the
// browser <audio> element cannot send one) ---
app.get('/stream', mediaLimiter, streamingController.handleStream);
app.get('/duration', mediaLimiter, YouTubeController.getDuration);

// --- History (our own login required) ---
app.post('/history', requireAuth, historyController.logHistory);
app.get('/history', requireAuth, historyController.getHistory);

// --- Custom playlists (our own login required) ---
app.get('/api/custom-playlists', requireAuth, playlistController.getCustomPlaylists);
app.post('/api/custom-playlists', requireAuth, playlistController.createCustomPlaylist);
app.get('/api/custom-playlists/:playlistId/tracks', requireAuth, playlistController.getCustomPlaylistTracks);
app.post('/api/custom-playlists/:playlistId/tracks', requireAuth, playlistController.addTrackToPlaylist);

// --- 404 (JSON, not Express's default HTML) ---
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// --- Central error handler. Controllers call next(err); this is the single
// place that logs the detail and returns a safe, generic message to the client.
// Express only treats a handler as an error handler if it declares 4 args. ---
app.use((err, req, res, next) => {
    if (err && err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    console.error('Unhandled error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
