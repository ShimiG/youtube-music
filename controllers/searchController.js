require('dotenv').config();
const { google } = require('googleapis');
const NodeCache = require('node-cache');

const searchCache = new NodeCache({ stdTTL: 3600 });

const searchYouTube = async (req, res) => {
    const userQuery = req.query.q;
    const token = req.oauthToken;

    if (!userQuery) return res.status(400).json({ error: "Missing query" });

    const cacheKey = `search_${userQuery.toLowerCase()}`;

    const cachedData = searchCache.get(cacheKey);
    if (cachedData)
        return res.status(200).json(cachedData);
    

    try {

        let youtube;
        if (token && token !== 'null' && token !== 'undefined') {
            const oauth2Client = new google.auth.OAuth2();
            oauth2Client.setCredentials({ access_token: token });
            youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        } else {
            youtube = google.youtube({ version: 'v3', auth: process.env.YOUTUBE_API_KEY });
        }

        const response = await youtube.search.list({
            part: 'snippet',
            q: userQuery,
            type: 'video',
            videoCategoryId: '10', 
            maxResults: 10
        });

        searchCache.set(cacheKey, response.data);

        res.status(200).json(response.data);

    } catch (error) {
        console.error("Search API Error:", error.message);
        if (error.code === 403) {
            return res.status(403).json({ error: "Quota exceeded or Invalid Permissions." });
        }
        res.status(error.code || 500).json({ 
            error: error.message || "Search failed" 
        });
    }
};

module.exports = { searchYouTube };