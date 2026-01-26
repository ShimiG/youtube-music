require('dotenv').config(); // Load environment variables first!
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const searchRoute = require('./routes/search');
const authRoutes = require('./routes/auth');
const app = express();

// --- MIDDLEWARE ---
// Allows the server to accept JSON data in requests (e.g., POST requests)
app.use(express.json());
// Allows other domains to talk to your API
app.use(cors());

// --- API ROUTES ---
app.use('/search', searchRoute);
app.use('/playlist', require('./routes/playlist'));
app.use('/auth', authRoutes);

// --- SERVE REACT BUILD ---
// Serve static files from the dist folder (React build output)
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback: Serve index.html for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- DATABASE CONNECTION ---
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Failed:', error.message);
        process.exit(1); // Exit with failure
    }
};

// --- ROUTES ---
// 1. Health Check (To test if server is running)
app.get('/', (req, res) => {
    res.status(200).send('YouTube Music API is running...');
});

// Placeholder for your future routes
// app.use('/api/songs', require('./routes/songRoutes'));

// --- START SERVER ---
const PORT = process.env.PORT || 3000;

// Connect to DB first, then start server
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});