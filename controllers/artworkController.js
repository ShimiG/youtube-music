// Theme colours from cover art (issue #26):
//   GET /api/artwork/colors?url=<https image URL>
// -> { status: 'ok', color, background, surface, accent } or { status: 'none' }
// See services/artworkColors.js for how the image is fetched safely.
const artwork = require('../services/artworkColors');

const getColors = async (req, res, next) => {
    try {
        const result = await artwork.getColors(req.app.locals.db, req.query.url);
        res.set('Cache-Control', 'no-store');
        return res.json(result);
    } catch (err) {
        if (err instanceof artwork.ArtworkError && err.code === 'BAD_URL') {
            return res.status(400).json({ error: err.message });
        }
        return next(err);
    }
};

module.exports = { getColors };
