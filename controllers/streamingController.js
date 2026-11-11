const YouTubeController = require('./YouTubeController');
const soundcloudController = require('./soundcloudController');
const audiusController = require('./audiusController');
const deezerController = require('./deezerController');
const localController = require('./localController');
const { handlersFor } = require('./matchedStream');

// Every source that plays through the server. Adding one means adding its
// stream and duration handlers here; app.js never learns service details.
const SOURCES = {
    youtube: { stream: YouTubeController.streamTrack, duration: YouTubeController.getDuration },
    soundcloud: { stream: soundcloudController.streamTrack, duration: soundcloudController.getDuration },
    audius: { stream: audiusController.streamTrack, duration: audiusController.getDuration },
    deezer: { stream: deezerController.streamTrack, duration: deezerController.getDuration },
    local: { stream: localController.streamTrack, duration: localController.getDuration },
    // Spotify has no audio we can fetch: the match engine picks a YouTube video
    // for the track first and playback is served from the YouTube path with
    // that id (sources.id 2 = spotify already exists in config/db.js).
    spotify: handlersFor('spotify')
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
