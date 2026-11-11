// Deezer playback (issue #38). Deezer gives us metadata and a 30-second
// preview, not full tracks, so each play decides at play time:
//   full     the match engine found the recording on YouTube (by ISRC, title,
//            artist and duration): stream that video through the YouTube path
//            (its cache, seeking and limits);
//   preview  no match, or matching is unavailable right now: stream Deezer's
//            30-second preview (not cached; preview URLs are signed and expire);
//   none     neither: TRACK_UNAVAILABLE.
// /stream and /duration run the same decision; the match engine remembers the
// answer (track_matches) and de-duplicates in-flight lookups, so a play costs
// one Deezer request and at most one YouTube search.
const deezer = require('../providers/deezer');
const matcher = require('../services/matcher');
const YouTubeController = require('./YouTubeController');
const { parseSeek, streamTranscoded } = require('./transcode');
const { sendSourceError } = require('../services/errors');

async function playbackPlan(db, id) {
    const raw = await deezer.getTrack(id);
    let match = null;
    try {
        match = await matcher.resolve(db, deezer.matchInput(raw));
    } catch (err) {
        console.warn(`Deezer ${id}: matching failed, using the preview: ${err && err.message}`);
    }
    if (match && match.status === 'matched' && YouTubeController.isValidVideoId(match.videoId)) {
        return { kind: 'full', videoId: match.videoId };
    }
    const preview = deezer.previewUrlOf(raw);
    return preview ? { kind: 'preview', url: preview } : { kind: 'none' };
}

function sendDeezerError(res, err, id) {
    if (res.headersSent) return;
    if (err && err.code === 'RATE_LIMITED') {
        return res.status(429).json({ error: err.message, code: 'SOURCE_RATE_LIMITED', source: 'deezer' });
    }
    if (err && err.code === 'NOT_FOUND') {
        return sendSourceError(res, 'TRACK_UNAVAILABLE', 'deezer', { status: 404, reason: 'not_found' });
    }
    console.error(`Deezer ${id}: could not prepare playback: ${err && err.message}`);
    return sendSourceError(res, 'TRACK_UNAVAILABLE', 'deezer', { reason: 'resolve_failed' });
}

function readId(req, res) {
    const id = req.query.videoId;
    if (!id || id === 'undefined') { res.status(400).json({ error: 'Missing videoId' }); return null; }
    if (!deezer.isValidId(id)) { res.status(400).json({ error: 'Invalid videoId' }); return null; }
    return id;
}

const streamTrack = async (req, res) => {
    const id = readId(req, res);
    if (!id) return;
    const { seekTime, error: seekError } = parseSeek(req.query.seek);
    if (seekError) return res.status(400).json({ error: seekError });

    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });

    let plan;
    try {
        plan = await playbackPlan(req.app.locals.db, id);
    } catch (err) {
        return sendDeezerError(res, err, id);
    }
    if (clientGone) return;

    if (plan.kind === 'full') return YouTubeController.streamVideo(req, res, plan.videoId);
    if (plan.kind === 'preview') {
        return streamTranscoded(req, res, { sourceUrl: plan.url, cacheKey: `deezer_${id}`, seekTime, allowCache: false });
    }
    return sendSourceError(res, 'TRACK_UNAVAILABLE', 'deezer', { status: 404, reason: 'no_match_no_preview' });
};

// { duration, preview }: what will actually play, so the player's progress
// bar and its "stream ended early" check are right for a 30 s preview.
const getDuration = async (req, res) => {
    const id = readId(req, res);
    if (!id) return;
    try {
        const plan = await playbackPlan(req.app.locals.db, id);
        if (plan.kind === 'full') {
            const seconds = await YouTubeController.durationOf(plan.videoId, { res }).catch(() => 0);
            if (!res.headersSent) res.json({ duration: seconds, preview: false });
            return;
        }
        if (plan.kind === 'preview') return res.json({ duration: deezer.PREVIEW_SECONDS, preview: true });
        return res.status(404).json({ duration: 0, code: 'TRACK_UNAVAILABLE', source: 'deezer' });
    } catch {
        if (!res.headersSent) res.status(502).json({ duration: 0 });
    }
};

module.exports = { streamTrack, getDuration, playbackPlan };
