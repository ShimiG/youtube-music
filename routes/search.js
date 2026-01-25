require('dotenv').config();
const express = require('express');
const axios = require('axios');
const router = express.Router();

// Route: GET /search
// Example URL: http://localhost:3000/search?q=bohemian
router.get('/', async (req, res) => {
    // 1. EXTRACT: Access the input from the URL
    // We expect the URL to look like: /search?q=Something
    const userQuery = req.query.q; 

    // 2. VALIDATE: Always protect your code from bad input
    if (!userQuery) {
        return res.status(400).json({ error: "Please provide a search term (e.g., ?q=songname)" });
    }

    // 3. RESPOND (For now, just echo it back to prove it works)
    try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                part: 'snippet',
                maxResults: 10,
                q: userQuery,
                key: process.env.YOUTUBE_API_KEY
            }
        });
        res.status(200).json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).json({ 
            error: "Error fetching YouTube data", 
            details: error.response?.data 
        });
    }
});

module.exports = router;