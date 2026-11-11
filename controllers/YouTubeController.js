const { execFile } = require('child_process');
const { parseSeek, serveFromCache, streamTranscoded, qualityCacheKey } = require('./transcode');
const { ytDlpPath } = require('../services/ytdlp');
const { sendSourceError } = require('../services/errors');

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

function runYtDlp(res, args, onDone) {
    let clientGone = false;
    const child = runner.execFile(ytDlpPath, args, { timeout: YTDLP_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        if (clientGone) return; // nobody to answer; never start ffmpeg for a dead request
        onDone(error, stdout, stderr);
    });
    res.on('close', () => {
        if (res.writableFinished) return; // normal completion
        clientGone = true;
        if (child && child.exitCode === null) child.kill('SIGKILL');
    });
    return child;
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
    if (serveFromCache(res, cacheKey)) return;

    // Ask for the audio stream explicitly. A bare `-g` lets yt-dlp choose its
    // default "best video + best audio", which prints TWO URLs (one per line);
    // both used to reach ffmpeg as one invalid address. bestaudio/best always
    // yields a single URL; `best` covers videos with only combined formats.
    const args = ['-f', 'bestaudio/best', '--no-playlist', '-g', `https://www.youtube.com/watch?v=${videoId}`];

    runYtDlp(res, args, (error, stdout, stderr) => {
        if (error) {
            console.error(`YouTube ${videoId}: could not resolve audio: ${describeYtDlpFailure(error, stderr)}`);
            if (!res.headersSent) sendSourceError(res, 'TRACK_UNAVAILABLE', 'youtube', { reason: 'resolve_failed' });
            return;
        }

        // First URL only, defensively: never pass a multi-line string to ffmpeg.
        const audioUrl = String(stdout).split('\n').map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
        if (!audioUrl) {
            console.error(`YouTube ${videoId}: yt-dlp returned no audio URL.`);
            if (!res.headersSent) sendSourceError(res, 'TRACK_UNAVAILABLE', 'youtube', { reason: 'no_audio_url' });
            return;
        }

        streamTranscoded(req, res, { sourceUrl: audioUrl, cacheKey, seekTime });
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
// bounded by YTDLP_TIMEOUT_MS, and when `res` is given it is killed as soon as
// that client disconnects (security review 2026-11-08: orphaned processes).
function durationOf(videoId, { res } = {}) {
    if (!isValidVideoId(videoId)) return Promise.reject(new Error('Invalid videoId'));
    if (durationCache.has(videoId)) return Promise.resolve(durationCache.get(videoId));

    const args = ['--print', 'duration', `https://www.youtube.com/watch?v=${videoId}`];

    return new Promise((resolve, reject) => {
        const child = runner.execFile(ytDlpPath, args, { timeout: YTDLP_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                console.error(`YouTube ${videoId}: could not read duration: ${describeYtDlpFailure(error, stderr)}`);
                return reject(error);
            }
            const durationInSeconds = parseInt(stdout.trim(), 10) || 0;
            if (durationCache.size >= DURATION_CACHE_MAX) {
                durationCache.delete(durationCache.keys().next().value);
            }
            durationCache.set(videoId, durationInSeconds);
            resolve(durationInSeconds);
        });
        if (res) {
            res.on('close', () => {
                if (res.writableFinished) return;
                if (child && child.exitCode === null) child.kill('SIGKILL');
            });
        }
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

module.exports = { streamTrack, getDuration, streamVideo, durationOf, isValidVideoId, describeYtDlpFailure, runner, YTDLP_TIMEOUT_MS };
