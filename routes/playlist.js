const express = require('express');
const router = express.Router();
const { getYouTubeLikes, likeVideo, getUserPlaylists, getPlaylistTracks } = require('../controllers/playlistController');

router.get('/mine', getYouTubeLikes);
router.post('/like', likeVideo);

router.get('/lists', getUserPlaylists);         
router.get('/lists/:playlistId', getPlaylistTracks);
module.exports = router;