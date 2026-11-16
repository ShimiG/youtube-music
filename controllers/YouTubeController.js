const { execFile, spawn } = require('child_process');
const { parseSeek, serveFromCache, streamTranscoded, qualityCacheKey } = require('./transcode');
const { ytDlpPath, jsRuntimeArgs } = require('../services/ytdlp');
// Lengths are remembered there, across restarts, so /duration does not start
// yt-dlp for a track that has been seen before.
const trackLengths = require('../services/trackLengths');
const playReport = require('../services/playReport');

// yt-dlp must never outlive the request that asked for it: bounded by a
// timeout, and killed as soon as the client disconnects. `runner.execFile` is
// wrapped so tests can stub the process.
const YTDLP_TIMEOUT_MS = 60 * 1000;
// Tests replace `runner.spawn` with a stand-in; one that forgot to must not
// start a real download from YouTube.
const notInTests = (...args) => {
    if (process.env.NODE_ENV === 'test') throw new Error('yt-dlp downloads are not run in tests: stub runner.spawn');
    return spawn(...args);
};
const runner = { execFile, spawn: notInTests };

// Turns a failed yt-dlp run into one log line that says what to do. Its own
// last error line is the useful part ("Sign in to confirm you're not a bot",
// "Video unavailable", "Requested format is not available", ...). Control
// characters are stripped so the text can't forge extra log lines.
function describeYtDlpFailure(error, stderr) {
    if (error && error.code === 'ENOENT') {
        return `yt-dlp not found at "${ytDlpPath()}". Install it (brew install yt-dlp) or set YTDLP_PATH.`;
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
    trackLengths.remember('youtube', videoId, seconds);
}

// yt-dlp's warnings say when it works with less than it should ("No supported
// JavaScript runtime could be found", "... formats have been skipped"). Each
// distinct one goes to the log once; the latest goes with the play, where the
// app shows it (services/playReport.js).
const warned = new Set();
function firstWarning(stderr) {
    const line = String(stderr || '').split('\n').map((l) => l.trim()).find((l) => /^WARNING:/.test(l));
    if (!line) return null;
    // eslint-disable-next-line no-control-regex
    const text = line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
    if (!warned.has(text) && warned.size < 20) {
        warned.add(text);
        console.warn(`yt-dlp: ${text}`);
    }
    return text;
}

function startResolving(videoId) {
    // --print implies "do not download". bestaudio/best always yields a single
    // address; a bare default would print two (video and audio).
    // Besides the length and the address: the request headers yt-dlp itself
    // would fetch that address with (ffmpeg is given the same ones, as yt-dlp
    // does when it runs ffmpeg), and which rendition it chose, for the report.
    const args = [
        '-f', 'bestaudio/best', '--no-playlist', ...jsRuntimeArgs(),
        '--print', 'duration', '--print', 'urls',
        '--print', '%(http_headers)j',
        '--print', 'chosen: format %(format_id)s, %(protocol)s, %(acodec)s',
        `https://www.youtube.com/watch?v=${videoId}`
    ];
    const job = { waiters: 0, done: false, child: null, promise: null };
    job.promise = new Promise((resolve, reject) => {
        job.child = runner.execFile(ytDlpPath(), args, { timeout: YTDLP_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
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
            let headers = null;
            try {
                const parsed = JSON.parse(lines.find((l) => l.startsWith('{')) || 'null');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed;
            } catch { /* an older yt-dlp, or none given */ }
            const chosenLine = lines.find((l) => l.startsWith('chosen: '));
            const chosen = chosenLine ? chosenLine.slice('chosen: '.length).slice(0, 120) : null;
            const warning = firstWarning(stderr);
            if (duration > 0) rememberDuration(videoId, duration);
            if (url) {
                const expiresAt = urlExpiry(url);
                if (expiresAt > Date.now()) {
                    if (resolved.size >= RESOLVED_MAX) resolved.delete(resolved.keys().next().value);
                    resolved.set(videoId, { url, duration, headers, chosen, warning, expiresAt });
                }
            }
            return resolve({ url, duration, headers, chosen, warning });
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
        return Promise.resolve({ url: known.url, duration: known.duration, headers: known.headers, chosen: known.chosen, warning: known.warning, from: 'memory', ms: 0 });
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
    return job.promise.then((found) => ({ ...found, from: running ? 'shared' : 'yt-dlp', ms: Date.now() - startedAt }));
}

// --- Downloading ---------------------------------------------------------------
//
// Until November 2026 the app asked yt-dlp for the audio's address and gave
// that to ffmpeg. YouTube's media servers now answer such a request with 403
// Forbidden: the audio has to be asked for the way yt-dlp does it (in ranged
// pieces, and whatever YouTube requires next). So yt-dlp fetches the audio
// itself and writes it to its standard output, and ffmpeg reads it from
// there (controllers/transcode.js, connectFeed). What yt-dlp can download,
// the app can play; when YouTube changes again, a new yt-dlp is the fix, and
// the app updates yt-dlp by itself.
//
// With `-o -` yt-dlp keeps its standard output for the audio and writes
// everything else to its standard error: the lines asked for with --print
// (the length, what it chose), warnings and errors.
const FEED_TAIL_CHARS = 4000;

/** For transcode's `feed`: starts yt-dlp downloading the audio of `videoId`. */
function downloadFeed(videoId, { res, timing } = {}) {
    return () => {
        const startedAt = Date.now();
        const args = [
            '-f', 'bestaudio/best', '--no-playlist', ...jsRuntimeArgs(),
            '--no-part', '--no-simulate',
            '--print', 'length: %(duration)s',
            '--print', 'chosen: format %(format_id)s, %(protocol)s, %(acodec)s',
            '-o', '-',
            `https://www.youtube.com/watch?v=${videoId}`
        ];
        const child = runner.spawn(ytDlpPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        // How long it took yt-dlp to start delivering: the look-up, in effect.
        child.stdout.once('data', () => {
            if (timing && timing.resolveMs === null) {
                timing.resolveMs = Date.now() - startedAt;
                timing.resolvedBy = 'yt-dlp';
            }
        });
        let tail = '';
        let pending = '';
        let lastError = null;
        child.stderr.on('data', (data) => {
            const text = data.toString();
            tail = (tail + text).slice(-FEED_TAIL_CHARS);
            pending += text;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop().slice(-FEED_TAIL_CHARS); // an unfinished line waits for its end
            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                const length = /^length: (\d+(?:\.\d+)?)$/.exec(line);
                if (length) {
                    const seconds = Math.round(Number(length[1]));
                    if (seconds > 0) rememberDuration(videoId, seconds);
                } else if (line.startsWith('chosen: ')) {
                    if (res) playReport.note(res, `yt-dlp ${line.slice(0, 140)}`.replace('chosen:', 'chose'));
                } else if (/^WARNING:/.test(line)) {
                    const warning = firstWarning(line);
                    if (res && warning) playReport.note(res, `yt-dlp: ${warning}`);
                } else if (/^ERROR:/.test(line)) {
                    // eslint-disable-next-line no-control-regex
                    lastError = line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
                }
            }
        });
        return {
            child,
            // Its own account of a failure; null when it did not fail.
            failure(code, signal, { endedByUs = false } = {}) {
                if (lastError) return `yt-dlp: ${lastError}`;
                if (endedByUs || (code === 0 && !signal)) return null;
                if (code === -1) return `yt-dlp not found at "${ytDlpPath()}". Install it (brew install yt-dlp) or set YTDLP_PATH.`;
                return `yt-dlp: ${describeYtDlpFailure({}, tail)} (${signal ? `ended by ${signal}` : `exit code ${code}`})`;
            }
        };
    };
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

    // yt-dlp downloads the audio and ffmpeg converts what it is handed (see
    // downloadFeed). There is no look-up beforehand any more: the first
    // thing yt-dlp does in that one run is the look-up.
    const timing = { label: `youtube ${videoId}`, resolveMs: null, resolvedBy: null };
    streamTranscoded(req, res, {
        feed: downloadFeed(videoId, { res, timing }),
        cacheKey,
        seekTime,
        timing
    });
    return undefined;
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
    // Seen before (by yt-dlp, in a list, in an earlier run of the app): no
    // look-up. This is what lets a track replayed from the disk cache start
    // without yt-dlp running at all.
    const inMemory = trackLengths.peek('youtube', videoId);
    if (inMemory) return Promise.resolve(inMemory);
    // The same run that finds the audio address: a play that asks for both
    // at once starts yt-dlp once.
    const lookUp = () => resolveVideo(videoId, { res }).then((found) => found.duration).catch((error) => {
        console.error(`YouTube ${videoId}: could not read duration: ${error.detail || describeYtDlpFailure(error, '')}`);
        throw error;
    });
    if (!trackLengths.persistent()) return lookUp();
    return trackLengths.known('youtube', videoId).then((seconds) => seconds || lookUp());
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
    trackLengths._reset();
}

module.exports = { streamTrack, getDuration, streamVideo, durationOf, resolveVideo, urlExpiry, isValidVideoId, describeYtDlpFailure, runner, YTDLP_TIMEOUT_MS, _resetResolver };
