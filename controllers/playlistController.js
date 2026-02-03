
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
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token" });
        
        const token = authHeader.replace('Bearer ', '');
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
    console.log("[Backend] Received like request...");

    try {
        // 1. Check Token
        const authHeader = req.header('Authorization');
        if (!authHeader) {
            console.error("[Backend] Error: No token provided");
            return res.status(401).json({ error: "No token" });
        }
        
        // 2. Clean Token (Remove 'Bearer ')
        const token = authHeader.replace('Bearer ', '');
        
        // 3. Get Video ID from Frontend
        const { videoId } = req.body; // <--- MUST MATCH Frontend JSON
        console.log(`[Backend] Liking video ID: ${videoId}`);

        if (!videoId) {
            return res.status(400).json({ error: "Missing videoId" });
        }

        // 4. Call YouTube API
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
    // --- CONTROLLER 3: Get User's Playlists ---
const getUserPlaylists = async (req, res) => {
    try {
        // 1. Get the raw header
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token provided." });

        // 2. CLEAN THE TOKEN: Remove "Bearer " if it exists
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
        
        // 3. SMART ERROR HANDLING
        // If Google says the token is bad (401 or 403), tell the Frontend it's a 401
        if (error.code === 401 || error.code === 403) {
            return res.status(401).json({ error: "Token expired or invalid" });
        }
        
        // Otherwise, it's a real server error
        res.status(500).json({ error: "Failed to fetch playlists." });
    }
};

    // --- CONTROLLER 4: Get Tracks from a Playlist ---

const getPlaylistTracks = async (req, res) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader) return res.status(401).json({ error: "No token" });
        const token = authHeader.replace('Bearer ', '');

        // ✅ FIX: Extract playlistId from the URL parameters
        const { playlistId } = req.params; 

        // Check if it's undefined
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

