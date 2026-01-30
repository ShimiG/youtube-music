
const { google } = require('googleapis');

const getYouTubeClient = (token) => {
    if (!token) throw new Error("No token provided");
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });
    return google.youtube({ version: 'v3', auth: oauth2Client });
};

// --- CONTROLLER 1: Get Liked Videos (Music Only) ---
const getYouTubeLikes = async (req, res) => {
    try {
        const token = req.header('Authorization');
        if (!token) return res.status(401).json({ error: "No valid token." });

        const youtube = getYouTubeClient(token);

        // 1. Fetch videos rated 'like'
        // We MUST request 'snippet' to see the categoryId
        const response = await youtube.videos.list({
            part: 'snippet,contentDetails,statistics',
            myRating: 'like',
            maxResults: 50 // Fetch more to ensure we have enough after filtering
        });

        // 2. FILTER: Only keep videos where categoryId === '10' (Music)
        // Note: Some music videos might be in other categories, but 10 is the standard.
        const musicVideos = response.data.items.filter(video => 
            video.snippet.categoryId === '10'
        );

        // 3. NORMALIZE (Match frontend structure)
        const normalizedItems = musicVideos.map(video => ({
            ...video,
            snippet: {
                ...video.snippet,
                resourceId: { videoId: video.id } 
            }
        }));

        res.json(normalizedItems);

    } catch (error) {
        console.error("Fetch Likes Error:", error.message);
        res.status(500).json({ error: "Failed to fetch liked videos." });
    }
};

// --- CONTROLLER 2: Like a Video ---
const likeVideo = async (req, res) => {
    const token = req.header('Authorization');
    const { videoId } = req.body;

    if (!token) return res.status(401).json({ error: "No token." });

    try {
        const youtube = getYouTubeClient(token);
        await youtube.videos.rate({ id: videoId, rating: 'like' });
        res.status(200).json({ message: "Success" });
    } catch (error) {
        console.error("Like Error:", error.message);
        if (error.code === 403) return res.status(403).json({ error: "Permission denied." });
        res.status(500).json({ error: "Failed to like video." });
    }
};

module.exports = { getYouTubeLikes, likeVideo };

