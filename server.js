require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { streamAudio } = require('./controllers/playController');
// Import Routes
const searchRoute = require('./routes/search');
const authRoutes = require('./routes/auth');
const playlistRoutes = require('./routes/playlist');
const { log } = require('console');

const app = express();
app.get('/test', (req, res) => {
    console.log("Server is working!");
});
// --- MIDDLEWARE ---
app.use(express.json()); // Parses incoming JSON requests
app.use(cors());         // Allows cross-origin requests
app.use(express.static('public')); // Serves your HTML file

// --- ROUTES ---
app.use('/search', searchRoute);
app.use('/playlist', playlistRoutes);
app.use('/auth', authRoutes);
app.get('/play', streamAudio);
// Health Check
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});