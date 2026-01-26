const Song = require('../models/song');

// Controller: Add a new song to the playlist
const addSong = async (req, res) => {
    const { title, channelTitle, thumbnailUrl, youTubeId } = req.body;

    try {
        const newSong = new Song({
            title,
            artist: channelTitle,
            youTubeId,
            thumbnailUrl,
            duration: 0,
            // IMPORTANT: Get the ID from the token (provided by middleware)
            owner: req.user.userId
        });

        await newSong.save();
        res.status(201).json(newSong);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Could not save song" });
    }
};

// Controller: Get all songs for the logged-in user
const getAllSongs = async (req, res) => {
    try {
        // Filter: Find songs where 'owner' matches the logged-in user's ID
        const mySongs = await Song.find({ owner: req.user.userId }).sort({ addedAt: -1 });
        res.status(200).json(mySongs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Could not fetch playlist" });
    }
};

// Controller: Delete a song from the playlist
const deleteSong = async (req, res) => {
    try {
        // Find and Delete, but ONLY if the owner matches
        const result = await Song.findOneAndDelete({
            _id: req.params.id,
            owner: req.user.userId
        });

        if (!result) {
            return res.status(404).json({ error: "Song not found or unauthorized" });
        }

        res.status(200).json({ message: "Deleted" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Delete failed" });
    }
};

module.exports = {
    addSong,
    getAllSongs,
    deleteSong
};
