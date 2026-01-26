const express = import('express');
const router = express.Router();
const { searchYouTube } = import('../controllers/searchController');

// Route: GET /search
// Traffic Cop: Routes the request to the controller
// Example URL: http://localhost:3000/search?q=bohemian
router.get('/', searchYouTube);

module.exports = router;
export default router;