
const { google } = require('googleapis');

    const getYouTubeClient = (token) => {
        if (!token) throw new Error("No token provided");
        const oauth2Client = new google.auth.OAuth2();
        oauth2Client.setCredentials({ access_token: token });
        return google.youtube({ version: 'v3', auth: oauth2Client });
    };

    const getYouTubeLikes = async (req, res) => {
       try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token" });
        
        const token = authHeader.replace('Bearer ', '');
            const youtube = getYouTubeClient(token);

            const response = await youtube.videos.list({
                part: 'snippet,contentDetails,statistics',
                myRating: 'like',
                maxResults: 50 // Fetch more to ensure we have enough after filtering
            });

            const musicVideos = response.data.items.filter(video => 
                video.snippet.categoryId === '10'
            );

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

const likeVideo = async (req, res) => {
    console.log("[Backend] Received like request...");

    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) {
            console.error("[Backend] Error: No token provided");
            return res.status(401).json({ error: "No token" });
        }
        
        const token = authHeader.replace('Bearer ', '');
        
        const { videoId } = req.body; // <--- MUST MATCH Frontend JSON
        console.log(`[Backend] Liking video ID: ${videoId}`);

        if (!videoId) {
            return res.status(400).json({ error: "Missing videoId" });
        }

        const youtube = getYouTubeClient(token);
        await youtube.videos.rate({
            id: videoId,
            rating: 'like'
        });

        console.log("[Backend] Success! Video liked.");
        res.sendStatus(200);

    } catch (error) {
        console.error("[Backend] Google API Error:", error.message);
        res.status(500).json({ error: "Could not like video" });
    }
};
const getUserPlaylists = async (req, res) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token provided." });

        const token = authHeader.replace('Bearer ', '');

        const youtube = getYouTubeClient(token);

        const response = await youtube.playlists.list({
            part: 'snippet,contentDetails',
            mine: true,
            maxResults: 50
        });

        res.json(response.data.items);
    } catch (error) {
        console.error("Fetch Playlists Error:", error.message);
        
        if (error.code === 401 || error.code === 403) {
            return res.status(401).json({ error: "Token expired or invalid" });
        }
        
        res.status(500).json({ error: "Failed to fetch playlists." });
    }
};


const getPlaylistTracks = async (req, res) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token" });
        const token = authHeader.replace('Bearer ', '');

        const { playlistId } = req.params; 

        if (!playlistId) return res.status(400).json({ error: "Missing Playlist ID" });

        const youtube = getYouTubeClient(token);

        const response = await youtube.playlistItems.list({
            part: 'snippet,contentDetails',
            playlistId: playlistId, // Now this variable exists
            maxResults: 50
        });

        const tracks = response.data.items.map(item => ({
            id: item.snippet.resourceId.videoId,
            title: item.snippet.title,
            artist: item.snippet.videoOwnerChannelTitle,
            image: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
            source: 'youtube'
        }));

        res.json(tracks);
    } catch (error) {
        console.error("Fetch Tracks Error:", error.message);
        res.status(500).json({ error: "Failed to fetch tracks" });
    }
};

module.exports = { 
    getYouTubeLikes, 
    likeVideo, 
    getUserPlaylists,   
    getPlaylistTracks   
};

