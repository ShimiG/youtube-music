const express = require('express');
const router = express.Router();
const { addSong, getAllSongs, deleteSong } = require('../controllers/playlistController');

// Route: GET /playlist
// Traffic Cop: Routes the request to the controller
router.get('/', getAllSongs);

// Route: POST /playlist/add
// Traffic Cop: Routes the request to the controller
router.post('/add', addSong);

// Route: DELETE /playlist/:id
// Traffic Cop: Routes the request to the controller
router.delete('/:id', deleteSong);

module.exports = router;