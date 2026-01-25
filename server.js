require('dotenv').config(); // Load environment variables first!
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const searchRoute = require('./routes/search');
const app = express();

// --- MIDDLEWARE ---
// Allows the server to accept JSON data in requests (e.g., POST requests)
app.use(express.json());
// Allows other domains to talk to your API
app.use(cors());
// Use the search route for handling /search requests
app.use('/search', searchRoute);
app.use(express.static('public'));
app.use('/playlist', require('./routes/playlist'));

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