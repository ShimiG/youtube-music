const Song = require('../models/song');

// Controller: Add a new song to the playlist
const addSong = async (req, res) => {
    const { title, channelTitle, thumbnailUrl, youTubeId } = req.body;

    try {
        const newSong = new Song({
            title: title,
            artist: channelTitle,
            youTubeId: youTubeId,
            thumbnailUrl: thumbnailUrl,
            duration: 0
        });

        await newSong.save();
        res.status(201).json(newSong);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Save failed" });
    }
};

// Controller: Get all songs from the playlist
const getAllSongs = async (req, res) => {
    try {
        const songs = await Song.find();
        res.status(200).json(songs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch songs" });
    }
};

// Controller: Delete a song from the playlist
const deleteSong = async (req, res) => {
    try {
        const songId = req.params.id;

        const result = await Song.findByIdAndDelete(songId);

        if (!result) {
            return res.status(404).json({ error: "Song not found" });
        }

        res.status(200).json({ message: "Song deleted successfully" });

    } catch (error) {
        res.status(500).json({ error: "Could not delete song" });
    }
};

module.exports = {
    addSong,
    getAllSongs,
    deleteSong
};
