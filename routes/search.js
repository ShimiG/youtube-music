const express = require('express');
const router = express.Router();
const { searchYouTube } = require('../controllers/searchController');

// Route: GET /search
// Traffic Cop: Routes the request to the controller
// Example URL: http://localhost:3000/search?q=bohemian
router.get('/', searchYouTube);

module.exports = router;