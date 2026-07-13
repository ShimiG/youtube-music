const { getYouTubeClient } = require('./youtubeClient');

const parseDuration = (isoDuration) => {
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = (isoDuration || '').match(regex);
    if (!matches) return 0;

    const hours = parseInt(matches[1] || 0);
    const minutes = parseInt(matches[2] || 0);
    const seconds = parseInt(matches[3] || 0);

    return (hours * 3600) + (minutes * 60) + seconds;
};

const searchTracks = async (req, res, next) => {
    const query = req.query.q;
    const token = req.oauthToken;

    if (typeof query !== 'string' || query.trim().length === 0 || query.length > 200) {
        return res.status(400).json({ error: 'A search query (q) of 1-200 characters is required' });
    }

    try {
        const youtube = getYouTubeClient(token);

        const searchResponse = await youtube.search.list({
            part: 'snippet',
            q: query,
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

        const cleanResults = videosResponse.data.items.map(video => ({
            id: video.id,
            title: video.snippet.title,
            channelTitle: video.snippet.channelTitle,
            thumbnail: video.snippet.thumbnails.default.url,
            duration: parseDuration(video.contentDetails.duration)
        }));

        res.json(cleanResults);
    } catch (error) {
        console.error('Search API Error:', error.message);
        if (error.code === 401 || (error.message && error.message.includes('Invalid Credentials'))) {
            return res.status(401).json({ error: 'Token expired or invalid' });
        }
        res.status(502).json({ error: 'Search provider request failed' });
    }
};

module.exports = { searchTracks };
