const express = require('express');
const router = express.Router();
const Song = require('../models/song'); // Import your Song Model

// Route: POST /playlist/add
router.post('/add', async (req, res) => {
    // 1. Get data from the frontend
    const { title, artist, youTubeId } = req.body;

    // 2. Simple Validation
    if (!title || !youTubeId) {
        return res.status(400).json({ error: "Missing song details" });
    }

    try {
        // 3. Create the song in memory
        const newSong = new Song({
            title: title,
            artist: artist || "Unknown",
            youTubeId: youTubeId,
            duration: 0 // Placeholder
        });

        // 4. Save to MongoDB
        await newSong.save();

        console.log(`✅ Saved: ${title}`);
        res.status(201).json({ message: "Song saved to library!", song: newSong });

    } catch (error) {
        console.error("Save Error:", error);
        res.status(500).json({ error: "Could not save song" });
    }
});

module.exports = router;