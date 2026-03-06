const express = require('express');
const router = express.Router();
const { searchTracks } = require('../controllers/searchController');

router.get('/', searchTracks);

module.exports = router;