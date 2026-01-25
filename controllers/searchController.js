require('dotenv').config();
const axios = require('axios');

// Controller: Search YouTube for songs
const searchYouTube = async (req, res) => {
    const userQuery = req.query.q;

    if (!userQuery) {
        return res.status(400).json({ error: "Please provide a search term (e.g., ?q=songname)" });
    }

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
};

module.exports = {
    searchYouTube
};
