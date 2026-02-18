const express = require('express');
const router = express.Router();
const { searchYouTube } = require('../controllers/searchController');

router.get('/', searchYouTube);

module.exports = router;