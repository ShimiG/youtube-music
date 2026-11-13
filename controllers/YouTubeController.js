const { execFile } = require('child_process');
const { parseSeek, serveFromCache, streamTranscoded, qualityCacheKey } = require('./transcode');
const { ytDlpPath } = require('../services/ytdlp');
const { sendSourceError } = require('../services/errors');
const usage = require('../services/usage');

// Small in-memory cache for /duration so we do not spawn yt-dlp for a track we
// already looked up. Bounded to avoid unbounded growth.
const durationCache = new Map();
const DURATION_CACHE_MAX = 500;

// yt-dlp must never outlive the request that asked for it: bounded by a
// timeout, and killed as soon as the client disconnects. `runner.execFile` is
// wrapped so tests can stub the process.
const YTDLP_TIMEOUT_MS = 60 * 1000;
const runner = { execFile };

// Turns a failed yt-dlp run into one log line that says what to do. Its own
// last error line is the useful part ("Sign in to confirm you're not a bot",
// "Video unavailable", "Requested format is not available", ...). Control
// characters are stripped so the text can't forge extra log lines.
function describeYtDlpFailure(error, stderr) {
    if (error && error.code === 'ENOENT') {
        return `yt-dlp not found at "${ytDlpPath}". Install it (brew install yt-dlp) or set YTDLP_PATH.`;
    }
    if (error && error.killed) return `yt-dlp timed out after ${YTDLP_TIMEOUT_MS / 1000}s.`;
    const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines.filter((l) => /^ERROR:/.test(l)).pop() || lines.pop() || (error && error.message) || 'unknown error';
    // eslint-disable-next-line no-control-regex
    return last.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
}

// --- One yt-dlp run per video ---------------------------------------------------
//
// Starting yt-dlp is the slow part of playing a track (seconds), and one play
// used to start it twice: /stream asked for the audio address and /duration,
// at the same moment, for the length; every seek and the next-track preload
// asked again. Now one run answers both questions, concurrent callers share
// it, and the answer is remembered for as long as the address is valid
// (docs/performance-plan.md, step 1.1).
//
// The rule from the 2026-11-08 security review still holds: yt-dlp never
// outlives the requests that asked for it. Each caller that passes its `res`
// is a waiter; when the last waiter's connection drops before the run is
// done, the process is killed. The timeout bounds it in every case.
const RESOLVED_MAX = 300;
const DEFAULT_URL_TTL_MS = 30 * 60 * 1000;
const MAX_URL_TTL_MS = 5 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 10 * 60 * 1000; // a track must be able to finish playing
const resolved = new Map(); // videoId -> { url, duration, expiresAt }
const resolving = new Map(); // videoId -> { promise, child, waiters, done }

// YouTube's media addresses say when they stop working ("expire=<unix time>",
// or "/expire/<unix time>/" in a manifest address).
function urlExpiry(url, now = Date.now()) {
    const m = /[?&/]expire[=/](\d{10})(?:\D|$)/.exec(url);
    const stated = m ? Number(m[1]) * 1000 - EXPIRY_MARGIN_MS : now + DEFAULT_URL_TTL_MS;
    return Math.min(stated, now + MAX_URL_TTL_MS);
}

function rememberDuration(videoId, seconds) {
    if (durationCache.size >= DURATION_CACHE_MAX) durationCache.delete(durationCache.keys().next().value);
    durationCache.set(videoId, seconds);
}

function startResolving(videoId) {
    // --print implies "do not download". bestaudio/best always yields a single
    // address; a bare default would print two (video and audio).
    const args = ['-f', 'bestaudio/best', '--no-playlist', '--print', 'duration', '--print', 'urls', `https://www.youtube.com/watch?v=${videoId}`];
    const job = { waiters: 0, done: false, child: null, promise: null };
    job.promise = new Promise((resolve, reject) => {
        job.child = runner.execFile(ytDlpPath, args, { timeout: YTDLP_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
            job.done = true;
            if (resolving.get(videoId) === job) resolving.delete(videoId);
            if (error) {
                error.detail = describeYtDlpFailure(error, stderr);
                return reject(error);
            }
            const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
            // First address only, defensively: never pass two lines to ffmpeg.
            const url = lines.find((l) => /^https?:\/\//.test(l)) || null;
            const numeric = lines.find((l) => /^\d+(\.\d+)?$/.test(l));
            const duration = numeric ? Math.round(Number(numeric)) : 0;
            if (duration > 0) rememberDuration(videoId, duration);
            if (url) {
                const expiresAt = urlExpiry(url);
                if (expiresAt > Date.now()) {
                    if (resolved.size >= RESOLVED_MAX) resolved.delete(resolved.keys().next().value);
                    resolved.set(videoId, { url, duration, expiresAt });
                }
            }
            return resolve({ url, duration });
        });
    });
    // A run whose waiters all left is killed and rejects with nobody listening.
    job.promise.catch(() => {});
    resolving.set(videoId, job);
    return job;
}

/**
 * The audio address and length of a video: { url, duration, from, ms }.
 * `from` says what it cost: "memory" (nothing), "shared" (joined a run that
 * another request started) or "yt-dlp" (started one). Rejects when yt-dlp
 * fails; `error.detail` is the one-line reason.
 */
function resolveVideo(videoId, { res } = {}) {
    const startedAt = Date.now();
    const known = resolved.get(videoId);
    if (known && known.expiresAt > startedAt) {
        usage.record('ytdlp.resolve_cached');
        return Promise.resolve({ url: known.url, duration: known.duration, from: 'memory', ms: 0 });
    }
    resolved.delete(videoId);

    const running = resolving.get(videoId);
    const job = running || startResolving(videoId);
    job.waiters++;
    if (res) {
        let left = false;
        res.on('close', () => {
            if (left || res.writableFinished) return; // normal completion
            left = true;
            job.waiters--;
            if (job.waiters <= 0 && !job.done && job.child && job.child.exitCode === null) {
                // Nobody is waiting any more. A later request starts afresh
                // instead of joining a run that is being killed.
                if (resolving.get(videoId) === job) resolving.delete(videoId);
                job.child.kill('SIGKILL');
            }
        });
    }
    return job.promise.then(
        (found) => {
            const ms = Date.now() - startedAt;
            // Only the request that started the run is charged for it.
            if (!running) usage.record('ytdlp.resolve', { ms });
            return { ...found, from: running ? 'shared' : 'yt-dlp', ms };
        },
        (err) => {
            if (!running) usage.record('ytdlp.resolve_failed', { ms: Date.now() - startedAt });
            throw err;
        }
    );
}

/** Forgets a remembered address (it stopped working before its stated time). */
function forgetVideo(videoId) {
    resolved.delete(videoId);
}

// YouTube video ids are always exactly 11 URL-safe characters. Being strict
// here also keeps cache keys (`youtube_<id>`) well-formed.
function isValidVideoId(videoId) {
    return typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

// Streams the YouTube video `videoId` into `res`. Shared by the YouTube source
// (id straight from the query string) and by the match-mode sources, whose
// handler looks the id up in track_matches first (controllers/matchedStream.js).
// Taking the id as an argument instead of reading req.query keeps callers from
// having to mutate the request, and the cache key is always `youtube_<id>`,
// so a Spotify play and a YouTube play of the same video share one cache file.
function streamVideo(req, res, videoId) {
    if (!isValidVideoId(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    const { seekTime, error: seekError } = parseSeek(req.query.seek);
    if (seekError) return res.status(400).json({ error: seekError });

    // Cache hit: sendFile supports HTTP Range natively, so the browser can seek.
    const cacheKey = qualityCacheKey(req, `youtube_${videoId}`);
    if (serveFromCache(res, cacheKey, { req, seekTime })) return undefined;

    // The client may leave while yt-dlp runs: never answer a dead response,
    // and never start ffmpeg for one.
    let clientGone = false;
    res.on('close', () => { if (!res.writableFinished) clientGone = true; });

    return resolveVideo(videoId, { res }).then((found) => {
        if (clientGone) return;
        if (!found.url) {
            console.error(`YouTube ${videoId}: yt-dlp returned no audio URL.`);
            if (!res.headersSent) sendSourceError(res, 'TRACK_UNAVAILABLE', 'youtube', { reason: 'no_audio_url' });
            return;
        }
        streamTranscoded(req, res, {
            sourceUrl: found.url,
            cacheKey,
            seekTime,
            timing: { label: `youtube ${videoId}`, resolveMs: found.ms, resolvedBy: found.from },
            // ffmpeg could not open the address: do not hand it out again.
            onSourceFailed: () => forgetVideo(videoId)
        });
    }).catch((error) => {
        if (clientGone) return;
        console.error(`YouTube ${videoId}: could not resolve audio: ${error.detail || describeYtDlpFailure(error, '')}`);
        if (!res.headersSent) sendSourceError(res, 'TRACK_UNAVAILABLE', 'youtube', { reason: 'resolve_failed' });
    });
}

const streamTrack = async (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId || videoId === 'undefined') {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    return streamVideo(req, res, videoId);
};

// Resolves the duration of a YouTube video in whole seconds, through the
// bounded in-memory cache above. Rejects when yt-dlp fails; the HTTP handlers
// (ours below and the match-mode one) decide how to report that. yt-dlp is
// bounded by YTDLP_TIMEOUT_MS, and when `res` is given it is killed once every
// client waiting for it has disconnected (security review 2026-11-08).
function durationOf(videoId, { res } = {}) {
    if (!isValidVideoId(videoId)) return Promise.reject(new Error('Invalid videoId'));
    if (durationCache.has(videoId)) return Promise.resolve(durationCache.get(videoId));
    // The same run that finds the audio address: a play that asks for both
    // at once starts yt-dlp once.
    return resolveVideo(videoId, { res }).then((found) => found.duration).catch((error) => {
        console.error(`YouTube ${videoId}: could not read duration: ${error.detail || describeYtDlpFailure(error, '')}`);
        throw error;
    });
}

const getDuration = (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

    return durationOf(videoId, { res })
        .then((duration) => { if (!res.writableEnded) res.json({ duration }); })
        .catch(() => { if (!res.headersSent) res.status(502).json({ duration: 0 }); });
};

// Tests only.
function _resetResolver() {
    resolved.clear();
    resolving.clear();
    durationCache.clear();
}

module.exports = { streamTrack, getDuration, streamVideo, durationOf, resolveVideo, urlExpiry, isValidVideoId, describeYtDlpFailure, runner, YTDLP_TIMEOUT_MS, _resetResolver };
