const { google } = require('googleapis');
const sanitizer = require('../services/sanitizer');
const logger = require('../services/logger');

const parseDuration = (isoDuration) => {
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = isoDuration.match(regex);
    if (!matches) return 0;
    
    const hours = parseInt(matches[1] || 0);
    const minutes = parseInt(matches[2] || 0);
    const seconds = parseInt(matches[3] || 0);
    
    return (hours * 3600) + (minutes * 60) + seconds;
};

const getYouTubeClient = (token) => {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });
    return google.youtube({ version: 'v3', auth: oauth2Client });
};

const searchTracks = async (req, res) => {
    const query = req.query.q;
    const token = req.oauthToken; 

    if (!token) return res.status(401).send("Unauthorized: No token provided");
    
    // Input validation: Sanitize search query
    if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Invalid search query' });
    }
    
    const sanitizedQuery = query.trim();
    if (sanitizedQuery.length === 0 || sanitizedQuery.length > 500) {
        return res.status(400).json({ error: 'Search query must be 1-500 characters' });
    }

    try {
        const youtube = getYouTubeClient(token);

        const searchResponse = await youtube.search.list({
            part: 'snippet',
            q: sanitizedQuery,
            type: 'video',
            maxResults: 30
        });

        const items = searchResponse.data.items;
        if (!items || items.length === 0) return res.json([]);

        const videoIds = items.map(item => item.id.videoId).join(',');

        const videosResponse = await youtube.videos.list({
            part: 'contentDetails,snippet',
            id: videoIds
        });

        // PHASE 2: Sanitize response to prevent XSS
        const cleanResults = videosResponse.data.items.map(video => ({
            id: video.id,
            title: sanitizer.encodeHTML(video.snippet.title),
            channelTitle: sanitizer.encodeHTML(video.snippet.channelTitle),
            thumbnail: video.snippet.thumbnails.default.url,
            duration: parseDuration(video.contentDetails.duration) 
        }));

        res.json(cleanResults);

    } catch (error) {
        logger.error('Search API Error', { error: error.message });
        if (error.message && (error.message.includes('Invalid Credentials') || error.code === 401)) {
            return res.status(401).json({ error: "Token expired or invalid" });
        }
        res.status(500).send(error.message);
    }
};

module.exports = { searchTracks };