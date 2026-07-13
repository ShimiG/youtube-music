const YouTubeController = require('./YouTubeController');
// const SpotifyController = require('./SpotifyController'); // We will create this later!

const SUPPORTED_SOURCES = ['youtube', 'spotify'];

class StreamingController {
    static handleStream(req, res) {
        const source = (req.query.source || 'youtube').toLowerCase();

        // Never echo the raw parameter back into the response — that is how a
        // reflected XSS payload gets rendered by a browser.
        if (!SUPPORTED_SOURCES.includes(source)) {
            return res.status(400).json({ error: 'Unsupported streaming source' });
        }

        switch (source) {
            case 'youtube':
                return YouTubeController.streamTrack(req, res);
            case 'spotify':
                return res.status(501).json({ error: 'Spotify streaming not implemented yet' });
            default:
                return res.status(400).json({ error: 'Unsupported streaming source' });
        }
    }
}

module.exports = StreamingController;
