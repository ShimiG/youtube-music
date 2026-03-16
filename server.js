const express = require('express');
const cors = require('cors');
require('dotenv').config();

// --- IMPORT CONFIG & MIDDLEWARE ---
const initDB = require('./config/db');
const authMiddleware = require('./middleware/auth');

// --- IMPORT CONTROLLERS ---
const authController = require('./controllers/authController');
const searchController = require('./controllers/searchController');
const playlistController = require('./controllers/playlistController');
const historyController = require('./controllers/historyController');
const streamingController = require('./controllers/streamingController');
const YouTubeController = require('./controllers/YouTubeController');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// ROUTES
// ==========================================

// Auth Routes
app.get('/auth/google', authController.googleLogin);
app.get('/auth/google/callback', authController.googleCallback);

// Search Route
app.get('/search', authMiddleware, searchController.searchTracks);

// YouTube Playlist Routes
app.get('/playlists', authMiddleware, playlistController.getUserPlaylists);
app.get('/playlists/:id/tracks', authMiddleware, playlistController.getPlaylistTracks);

// YouTube Duration Route
app.get('/duration', YouTubeController.getDuration);

// Custom Playlist Routes (Local DB)
app.get('/api/custom-playlists', playlistController.getCustomPlaylists);
app.post('/api/custom-playlists', playlistController.createCustomPlaylist);
app.get('/api/custom-playlists/:playlistId/tracks', playlistController.getCustomPlaylistTracks);
app.post('/api/custom-playlists/:playlistId/tracks', playlistController.addTrackToPlaylist);

// History Routes
app.post('/history', historyController.logHistory);
app.get('/history', historyController.getHistory);

// Streaming Route
app.get('/stream', streamingController.handleStream);


// ==========================================
// SERVER INITIALIZATION
// ==========================================
initDB().then(db => {
    app.locals.db = db; 
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
});