const express = require('express');
const router = express.Router();
const { addSong, getAllSongs, deleteSong } = require('../controllers/playlistController');
const auth = require('../middleware/auth'); // Import the Guard

// Route: POST /playlist/add
// Traffic Cop: Routes the request to the controller with auth middleware
router.post('/add', auth, addSong);

// Route: GET /playlist
// Traffic Cop: Routes the request to the controller with auth middleware
router.get('/', auth, getAllSongs);

// Route: DELETE /playlist/:id
// Traffic Cop: Routes the request to the controller with auth middleware
router.delete('/:id', auth, deleteSong);

module.exports = router;