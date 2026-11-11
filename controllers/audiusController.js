// Audius playback: /stream and /duration with source=audius. The provider
// resolves the track's MP3 URL (or its preview, for a gated track); it then
// goes through the shared transcode pipeline like every other source, so it
// gets the same disk cache, seeking, transcode limits and media-token check
// (app.js) as YouTube and SoundCloud.
const audius = require('../providers/audius');
const { parseSeek, serveFromCache, streamTranscoded } = require('./transcode');
const { sendSourceError } = require('../services/errors');

function sendAudiusError(res, err, videoId) {
    if (res.headersSent) return;
    if (err && err.code === 'RATE_LIMITED') {
        return res.status(429).json({ error: err.message, code: 'SOURCE_RATE_LIMITED', source: 'audius' });
    }
    if (err && err.code === 'NOT_FOUND') {
        return sendSourceError(res, 'TRACK_UNAVAILABLE', 'audius', { status: 404, reason: 'not_streamable' });
    }
    console.error(`Audius ${videoId}: could not resolve audio: ${err && err.message}`);
    return sendSourceError(res, 'TRACK_UNAVAILABLE', 'audius', { reason: 'resolve_failed' });
}

const streamTrack = async (req, res) => {
    const id = req.query.videoId;
    if (!id || id === 'undefined') return res.status(400).json({ error: 'Missing videoId' });
    if (!audius.isValidId(id)) return res.status(400).json({ error: 'Invalid videoId' });

    const { seekTime, error: seekError } = parseSeek(req.query.seek);
    if (seekError) return res.status(400).json({ error: seekError });

    const cacheKey = `audius_${id}`;
    if (serveFromCache(res, cacheKey)) return;

    // Resolving is two API calls; if the listener leaves meanwhile, do not
    // start ffmpeg for a dead request.
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });

    let resolved;
    try {
        resolved = await audius.resolveStream(id);
    } catch (err) {
        return sendAudiusError(res, err, id);
    }
    if (clientGone) return;

    // A preview must not occupy the full track's cache entry.
    streamTranscoded(req, res, { sourceUrl: resolved.url, cacheKey, seekTime, allowCache: !resolved.isPreview });
};

const getDuration = async (req, res) => {
    const id = req.query.videoId;
    if (!id) return res.status(400).json({ error: 'Missing videoId' });
    if (!audius.isValidId(id)) return res.status(400).json({ error: 'Invalid videoId' });
    try {
        const track = await audius.getTrack(id);
        res.json({ duration: Number.isFinite(track.duration) ? track.duration : 0 });
    } catch {
        if (!res.headersSent) res.status(502).json({ duration: 0 });
    }
};

module.exports = { streamTrack, getDuration };
