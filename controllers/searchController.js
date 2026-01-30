// controllers/searchController.js
require('dotenv').config();
const { google } = require('googleapis');

const searchYouTube = async (req, res) => {
    const userQuery = req.query.q;
    const token = req.header('Authorization'); // Get token from frontend

    if (!userQuery) return res.status(400).json({ error: "Missing query" });

    try {
        let youtube;

        // 1. SETUP CLIENT
        if (token && token !== 'null' && token !== 'undefined') {
            // CASE A: User is Logged In -> Use their Token
            // This automatically adds "Bearer " and identifies the user to Google
            const oauth2Client = new google.auth.OAuth2();
            oauth2Client.setCredentials({ access_token: token });
            youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        } else {
            // CASE B: User is Logged Out -> Fallback to API Key
            // If you don't have a valid API Key in .env, this will fail
            youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
        }

        // 2. PERFORM SEARCH
        const response = await youtube.search.list({
            part: 'snippet',
            q: userQuery,
            type: 'video',
            videoCategoryId: '10', // Filter for Music
            maxResults: 10
        });

        // 3. SEND RESULTS
        res.status(200).json(response.data);

    } catch (error) {
        console.error("Search API Error:", error.message);
        
        // Handle specific Google Errors
        if (error.code === 403) {
            return res.status(403).json({ error: "Quota exceeded or Invalid Permissions." });
        }
        
        res.status(error.code || 500).json({ 
            error: error.message || "Search failed" 
        });
    }
};

module.exports = { searchYouTube };