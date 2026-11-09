// /stream and /duration for match-mode sources (Spotify today; Apple Music,
// Tidal and Deezer later). These sources have no audio we can fetch: the match
// engine (services/matcher) picks a YouTube video for each track first, and
// playback is served from the YouTube path with that id. The query parameter
// is still called `videoId` because every source's stream URL has the same
// shape; here it carries the source's own external id (a Spotify track id).
//
// Like the other stream routes this is unauthenticated: the <audio> element
// cannot send a Bearer header, and the match table is global, not per user.
const matcher = require('../services/matcher');
const YouTubeController = require('./YouTubeController');

// Same alphabet as the YouTube ids but up to 128 chars: Spotify ids are 22
// base62 chars, the other match sources use numeric ids.
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Validates the id and reads the match row. Sends the error response itself
// and returns null when there is nothing to play, so both handlers share one
// mapping of match status to HTTP status:
//   no row     -> 404 MATCH_REQUIRED    (the client must call /api/match/resolve first)
//   not_found  -> 404 TRACK_UNAVAILABLE (no official YouTube upload exists)
//   error      -> 503 MATCH_PENDING     (resolution failed; retried after MATCH_ERROR_TTL_MS)
//   pending    -> 503 MATCH_PENDING     (still resolving in the background)
async function matchedVideoId(req, res, sourceName) {
    const id = req.query.videoId;
    if (!id || id === 'undefined') {
        res.status(400).json({ error: 'Missing videoId' });
        return null;
    }
    if (typeof id !== 'string' || !EXTERNAL_ID.test(id)) {
        res.status(400).json({ error: 'Invalid videoId' });
        return null;
    }

    const row = await matcher.getMatch(req.app.locals.db, sourceName, id);
    if (!row) {
        res.status(404).json({ error: 'Track has not been matched yet', code: 'MATCH_REQUIRED' });
        return null;
    }
    if (row.status === 'matched' && YouTubeController.isValidVideoId(row.videoId)) {
        return row.videoId;
    }
    if (row.status === 'not_found') {
        res.status(404).json({ error: 'This track is not available on YouTube.', code: 'TRACK_UNAVAILABLE' });
        return null;
    }
    res.status(503).json({ error: 'The match for this track is not ready yet. Try again shortly.', code: 'MATCH_PENDING' });
    return null;
}

function handlersFor(sourceName) {
    const stream = async (req, res) => {
        let videoId;
        try {
            videoId = await matchedVideoId(req, res, sourceName);
        } catch (err) {
            console.error(`${sourceName}: match lookup failed:`, err && err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Could not look up the match for this track' });
            return;
        }
        if (!videoId) return;
        // Looked up through the module object (not destructured) so tests can
        // stub the YouTube side without spawning yt-dlp.
        return YouTubeController.streamVideo(req, res, videoId);
    };

    const duration = async (req, res) => {
        let videoId;
        try {
            videoId = await matchedVideoId(req, res, sourceName);
        } catch (err) {
            console.error(`${sourceName}: match lookup failed:`, err && err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Could not look up the match for this track' });
            return;
        }
        if (!videoId) return;
        try {
            const seconds = await YouTubeController.durationOf(videoId, { res });
            res.json({ duration: seconds });
        } catch {
            // Mirrors YouTubeController.getDuration: the player treats 0 as unknown.
            res.status(502).json({ duration: 0 });
        }
    };

    return { stream, duration };
}

module.exports = { handlersFor };
