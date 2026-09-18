const YouTubeController = require('./YouTubeController');
const soundcloudController = require('./soundcloudController');

// Every source that plays through the server. Adding one means adding its
// stream and duration handlers here; app.js never learns service details.
const SOURCES = {
    youtube: { stream: YouTubeController.streamTrack, duration: YouTubeController.getDuration },
    soundcloud: { stream: soundcloudController.streamTrack, duration: soundcloudController.getDuration }
};

function resolveSource(req, res) {
    const source = String(req.query.source || 'youtube').toLowerCase();
    // Never echo the raw parameter back into the response — that is how a
    // reflected XSS payload gets rendered by a browser.
    if (!Object.prototype.hasOwnProperty.call(SOURCES, source)) {
        res.status(400).json({ error: 'Unsupported streaming source' });
        return null;
    }
    return SOURCES[source];
}

class StreamingController {
    static handleStream(req, res) {
        const provider = resolveSource(req, res);
        if (provider) return provider.stream(req, res);
    }

    static handleDuration(req, res) {
        const provider = resolveSource(req, res);
        if (provider) return provider.duration(req, res);
    }
}

module.exports = StreamingController;
