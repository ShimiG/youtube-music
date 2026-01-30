const express = require('express');
const router = express.Router();
const { getYouTubeLikes, likeVideo } = require('../controllers/playlistController');

router.get('/mine', getYouTubeLikes);
router.post('/like', likeVideo);

module.exports = router;