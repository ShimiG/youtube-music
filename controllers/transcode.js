// Shared "resolve a remote audio URL, transcode it with ffmpeg, stream MP3 to
// the client, and keep a disk-cache copy" pipeline. Used by every source that
// plays through the server (YouTube via yt-dlp, SoundCloud via its streams
// endpoint). Cache files are named `<cacheKey>.mp3` and every key carries its
// source prefix (`youtube_<id>`, `soundcloud_<id>`), so ids can never collide
// across sources. The cache is bounded by total size (CACHE_MAX_BYTES, default
// 500 MB), evicting the least recently played files first.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dataDir, resolveFfmpeg } = require('../services/paths');

const ffmpegPath = resolveFfmpeg();
const cacheDir = path.join(dataDir(), 'cache');
const resolvedCacheDir = path.resolve(cacheDir);

const MAX_SEEK_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_TRANSCODE_MS = 10 * 60 * 1000; // never let a transcode run longer than this
const MIN_CACHE_BYTES = 100000; // smaller output means a broken/partial download
const DEFAULT_CACHE_MAX_BYTES = 500 * 1024 * 1024;
const LEGACY_YOUTUBE_FILE = /^[A-Za-z0-9_-]{11}\.mp3$/;

function cacheMaxBytes() {
    const raw = Number(process.env.CACHE_MAX_BYTES);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_MAX_BYTES;
}

// Audio quality of the transcode path (issue #39), chosen per request with
// ?quality=. YouTube, SoundCloud, Audius and Deezer previews are lossy at the
// source (roughly 128-160 kbps), so `high` cannot add detail; it avoids losing
// more in the conversion to MP3. Local MP3 / M4A / FLAC / WAV files do not come
// through here at all: they are sent as they are (controllers/localController.js).
// `standard` keeps the cache file names used before this setting existed.
const QUALITIES = Object.freeze({
    low: { bitrate: '96k', cacheSuffix: '_q96' },
    standard: { bitrate: '128k', cacheSuffix: '' },
    high: { bitrate: '256k', cacheSuffix: '_q256' }
});
const DEFAULT_QUALITY = 'standard';

const isValidQuality = (value) => value === undefined || Object.prototype.hasOwnProperty.call(QUALITIES, value);

/** The quality name a request asks for; `standard` when absent or unknown. */
function qualityOf(req) {
    const value = req && req.query ? req.query.quality : undefined;
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QUALITIES, value) ? value : DEFAULT_QUALITY;
}

/** The cache key for a track at the request's quality, e.g. youtube_<id>_q256. */
function qualityCacheKey(req, baseKey) {
    return `${baseKey}${QUALITIES[qualityOf(req)].cacheSuffix}`;
}

// Cache keys currently being written, so two concurrent plays of the same
// track do not both try to produce the same cache file.
const inFlightCaching = new Set();

// A transcode that is writing the cache keeps running after its client leaves,
// so the file is ready next time. That must be bounded, or anything that can
// make the browser request /stream (any web page, via <audio>) can pile up
// ffmpeg processes. Beyond this many, abandoned transcodes are killed.
const MAX_BACKGROUND_TRANSCODES = 2;
let backgroundTranscodes = 0;

// Hard ceiling on ffmpeg processes running at once, whatever their state. One
// listener needs two (the current track, plus the next one preloading) and up
// to MAX_BACKGROUND_TRANSCODES finishing in the background; beyond this the
// server answers 503 instead of starting another process.
const MAX_CONCURRENT_TRANSCODES = 6;
let activeTranscodes = 0;

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

// The player loads audio through an <audio> element whose origin (the Vite dev
// server, or the Tauri webview at tauri://localhost) differs from this API's.
// helmet() sets Cross-Origin-Resource-Policy: same-origin on every response,
// which makes the browser fetch the audio and then discard it before playback.
// Media responses must opt into cross-origin so the element can use them. This
// is about the client-vs-API origins only; the upstream audio source is
// irrelevant, since it is fetched and transcoded server-side and never reaches
// the browser directly. Every response an <audio> element consumes (both the
// cache hit and the live transcode) goes through the two functions below.
function setMediaHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

/**
 * Sends a whole local audio file as it is (local files, issue #24), with HTTP
 * Range support from sendFile so the browser can seek, and the same
 * cross-origin header as every other media response.
 */
function sendMediaFile(res, filePath, contentType) {
    setMediaHeaders(res);
    res.type(contentType);
    res.sendFile(filePath, { dotfiles: 'allow', headers: { 'Content-Type': contentType } });
}

// Only characters that are safe in a filename; bounded length.
function isValidCacheKey(key) {
    return typeof key === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(key);
}

/** Parses ?seek=. Returns { seekTime } or { error }. */
function parseSeek(rawSeek) {
    if (rawSeek === undefined) return { seekTime: 0 };
    const parsed = Number(rawSeek);
    if (!Number.isFinite(parsed)) return { error: 'Invalid seek parameter' };
    const seekTime = Math.floor(parsed);
    if (seekTime < 0 || seekTime > MAX_SEEK_SECONDS) return { error: 'Invalid seek parameter' };
    return { seekTime };
}

function cachePathFor(cacheKey) {
    const finalFilePath = path.resolve(resolvedCacheDir, `${cacheKey}.mp3`);
    if (!finalFilePath.startsWith(resolvedCacheDir + path.sep)) return null;
    return finalFilePath;
}

/**
 * Evicts the least recently played cache files until the total size of the
 * cache is at or below `maxBytes`. serveFromCache() touches a file's mtime on
 * every hit, so mtime order is play-recency order. Resolves with what it did.
 */
async function enforceCacheLimit(maxBytes = cacheMaxBytes(), dir = cacheDir) {
    let entries;
    try {
        entries = await fs.promises.readdir(dir);
    } catch (err) {
        console.error('Error reading cache directory:', err.message);
        return { evicted: 0, totalBytes: 0 };
    }

    const files = [];
    for (const name of entries) {
        if (!name.endsWith('.mp3') && !name.endsWith('.m4a')) continue;
        const fullPath = path.join(dir, name);
        try {
            const st = await fs.promises.stat(fullPath);
            if (st.isFile()) files.push({ path: fullPath, size: st.size, time: st.mtimeMs });
        } catch { /* removed meanwhile */ }
    }

    let totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    let evicted = 0;
    files.sort((a, b) => a.time - b.time);
    for (const file of files) {
        if (totalBytes <= maxBytes) break;
        try {
            await fs.promises.unlink(file.path);
            totalBytes -= file.size;
            evicted++;
        } catch (err) {
            console.error(`Failed to delete old cache file: ${path.basename(file.path)}`, err.message);
        }
    }
    return { evicted, totalBytes };
}

/**
 * Startup housekeeping: removes `.part` files left by a crash or kill, and
 * renames cache files from before source prefixes (`<11-char id>.mp3`, always
 * YouTube) to `youtube_<id>.mp3`. Then applies the size limit.
 */
async function prepareCache(dir = cacheDir) {
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch { return; }
    for (const name of entries) {
        const fullPath = path.join(dir, name);
        try {
            if (name.endsWith('.part')) {
                await fs.promises.unlink(fullPath);
            } else if (LEGACY_YOUTUBE_FILE.test(name)) {
                const target = path.join(dir, `youtube_${name}`);
                if (fs.existsSync(target)) await fs.promises.unlink(fullPath);
                else await fs.promises.rename(fullPath, target);
            }
        } catch (err) {
            console.warn(`Cache housekeeping skipped ${name}: ${err.message}`);
        }
    }
    await enforceCacheLimit(cacheMaxBytes(), dir);
}

// "Prepare" requests (?prepare=1) get a track ready without playing it: the
// client sends one shortly before the current track ends, so the next one
// starts from the disk cache instead of waiting for yt-dlp and ffmpeg
// (docs/performance-plan.md, step 1.3). They are answered at once with what
// was done; the conversion, if one was started, runs on its own into the cache.
const isPrepare = (req) => Boolean(req && req.query && req.query.prepare === '1');
const answerPrepare = (res, prepared) => {
    res.set('Cache-Control', 'no-store');
    res.json({ prepared });
};

// One line per play in the log (step 0 of the performance plan): what the
// wait before the first sound was made of. `req.playStartedAt` is set when the
// request arrives (controllers/streamingController.js).
function logPlay(req, timing, detail) {
    if (!timing || !timing.label) return;
    const total = req && req.playStartedAt ? `, ${Date.now() - req.playStartedAt} ms after the request` : '';
    const resolve = timing.resolvedBy ? `address ${timing.resolveMs} ms (${timing.resolvedBy}), ` : '';
    console.log(`Play ${timing.label}: ${resolve}${detail}${total}`);
}

/**
 * Serves the cached MP3 for `cacheKey` if one exists. Returns true when it
 * answered the request.
 *   - a normal play: the file itself, with HTTP Range support via sendFile, so
 *     the browser can seek;
 *   - a seek (`seekTime` > 0): converted from the cached file starting there.
 *     Sending the whole file used to restart the sound from 0:00 while the
 *     player's clock had moved on;
 *   - a prepare request: nothing to do, it is already there.
 */
function serveFromCache(res, cacheKey, { req, seekTime = 0, timing } = {}) {
    const finalFilePath = cachePathFor(cacheKey);
    if (!finalFilePath || !fs.existsSync(finalFilePath)) return false;
    const now = new Date();
    fs.utimes(finalFilePath, now, now, () => {});
    if (isPrepare(req)) {
        answerPrepare(res, 'cached');
        return true;
    }
    if (seekTime > 0 && req) {
        streamTranscoded(req, res, { sourceUrl: finalFilePath, cacheKey, seekTime, allowCache: false, timing: { label: `${cacheKey} (seek in cached file)` } });
        return true;
    }
    logPlay(req, timing || { label: cacheKey }, 'from the disk cache');
    setMediaHeaders(res);
    res.sendFile(finalFilePath);
    return true;
}

/**
 * Transcodes `sourceUrl` to MP3 and streams it into `res`. When `seekTime` is 0
 * and `allowCache` is true, a copy is written to the disk cache under
 * `cacheKey` once the transcode completes successfully.
 *
 * For a prepare request nothing is streamed: the conversion only fills the
 * cache, at full speed, as a background transcode (bounded like the ones a
 * departed client leaves behind).
 *
 * `timing` ({ label, resolveMs, resolvedBy }) adds a line to the log when the
 * first audio is ready. `onSourceFailed` is called when ffmpeg could not get
 * any audio out of `sourceUrl`.
 */
function streamTranscoded(req, res, { sourceUrl, cacheKey, seekTime = 0, allowCache = true, timing, onSourceFailed }) {
    const finalFilePath = cachePathFor(cacheKey);
    const prepare = isPrepare(req);
    const cacheable = allowCache && finalFilePath && seekTime === 0 && !inFlightCaching.has(cacheKey);

    if (prepare) {
        // Only worth a process when the result lands in the cache, and only
        // within the same bounds as any other background conversion.
        if (!allowCache || !finalFilePath || seekTime !== 0) return answerPrepare(res, 'skipped');
        if (inFlightCaching.has(cacheKey)) return answerPrepare(res, 'in_progress');
        if (backgroundTranscodes >= MAX_BACKGROUND_TRANSCODES || activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
            return answerPrepare(res, 'busy');
        }
    }

    // The reconnect options only exist for network inputs; ffmpeg refuses to
    // open a local file (`file:` input, local files) when they are given.
    const isNetworkInput = /^https?:\/\//i.test(sourceUrl);
    const ffmpegArgs = [
        ...(isNetworkInput ? ['-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
        '-ss', seekTime.toString(),
        '-i', sourceUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', QUALITIES[qualityOf(req)].bitrate,
        '-f', 'mp3',
        '-'
    ];

    if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: 'Too many streams in progress. Try again in a moment.', code: 'SERVER_BUSY' });
    }

    // windowsHide: the desktop app has no console; without it every transcode
    // would flash a console window on Windows.
    const spawnedAt = Date.now();
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true });
    let finished = false;
    let producedAudio = false;

    // Count this process until it is gone. A failed spawn emits 'error' and
    // may not emit 'close', so both release the slot, once.
    activeTranscodes++;
    let slotReleased = false;
    const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        activeTranscodes--;
    };

    // A prepare conversion has no client from the start.
    let inBackground = prepare;
    if (prepare) backgroundTranscodes++;

    // One place that guarantees the child process is gone. Called on error,
    // on completion, on client disconnect, and by the safety timeout.
    const cleanupTimer = setTimeout(() => {
        if (!finished) ffmpegProcess.kill('SIGKILL');
    }, MAX_TRANSCODE_MS);

    ffmpegProcess.on('error', (err) => {
        releaseSlot();
        console.error('Failed to start FFmpeg:', err.message);
        if (!prepare && !res.headersSent) res.status(500).json({ error: 'Audio processor unavailable' });
    });

    ffmpegProcess.stdout.once('data', () => {
        producedAudio = true;
        if (!prepare) logPlay(req, timing, `first audio ${Date.now() - spawnedAt} ms after starting ffmpeg${seekTime ? ` (seek to ${seekTime} s)` : ''}`);
    });

    if (prepare) {
        answerPrepare(res, 'started');
    } else {
        setMediaHeaders(res);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');
        ffmpegProcess.stdout.pipe(res);
    }

    // Only write a disk-cache copy for a full (seek==0) play, and only if no
    // other request is already caching this track.
    let fileStream = null;
    let safePartFilePath = null;
    if (cacheable) {
        const candidatePartPath = path.resolve(cacheDir, `${cacheKey}_${Date.now()}.part`);
        if (candidatePartPath.startsWith(resolvedCacheDir + path.sep)) {
            safePartFilePath = candidatePartPath;
            inFlightCaching.add(cacheKey);
            fileStream = fs.createWriteStream(safePartFilePath);
            ffmpegProcess.stdout.pipe(fileStream);
        }
    }
    // Nothing reads a prepare conversion that cannot be cached: stop it.
    if (prepare && !fileStream) ffmpegProcess.kill('SIGKILL');

    ffmpegProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('Invalid')) {
            console.error(`FFmpeg: ${msg.trim()}`);
        }
    });

    // Client went away. Stop sending to the (dead) response. If we are not
    // caching this stream, kill the transcode so it does not linger. If we ARE
    // caching, let it finish so the file lands in the cache for next time (the
    // safety timer still bounds it).
    // res 'close' with writableFinished=false means the connection dropped
    // before we finished (req 'close' is not a reliable disconnect signal).
    if (!prepare) {
        res.on('close', () => {
            if (res.writableFinished || finished) return;
            ffmpegProcess.stdout.unpipe(res);
            if (fileStream && backgroundTranscodes < MAX_BACKGROUND_TRANSCODES) {
                inBackground = true;
                backgroundTranscodes++;
                return;
            }
            // Killed runs exit non-zero, so the close handler drops the .part file.
            ffmpegProcess.kill('SIGKILL');
        });
    }

    // once: the counters below must move exactly one step per process.
    ffmpegProcess.once('close', (code) => {
        releaseSlot();
        finished = true;
        if (inBackground) backgroundTranscodes--;
        clearTimeout(cleanupTimer);
        if (fileStream) inFlightCaching.delete(cacheKey);
        if (code !== 0 && !producedAudio && typeof onSourceFailed === 'function') onSourceFailed();
        if (prepare && code === 0) console.log(`Prepared ${timing && timing.label ? timing.label : cacheKey} in ${Date.now() - spawnedAt} ms`);
        if (!fileStream) return;

        fileStream.end();
        setTimeout(() => {
            if (!safePartFilePath || !fs.existsSync(safePartFilePath)) return;
            const stats = fs.statSync(safePartFilePath);
            if (code === 0 && stats.size > MIN_CACHE_BYTES) {
                if (!fs.existsSync(finalFilePath)) {
                    fs.renameSync(safePartFilePath, finalFilePath);
                    enforceCacheLimit().catch(() => {});
                } else {
                    fs.unlinkSync(safePartFilePath);
                }
            } else {
                // Broken/partial download — never leave a .part file behind.
                fs.unlinkSync(safePartFilePath);
            }
        }, 250);
    });
    return undefined;
}

module.exports = {
    cacheDir,
    isValidCacheKey,
    parseSeek,
    QUALITIES,
    isValidQuality,
    qualityOf,
    qualityCacheKey,
    serveFromCache,
    isPrepare,
    answerPrepare,
    sendMediaFile,
    streamTranscoded,
    enforceCacheLimit,
    prepareCache,
    cacheMaxBytes,
    MAX_BACKGROUND_TRANSCODES,
    MAX_CONCURRENT_TRANSCODES,
    _activeTranscodes: () => activeTranscodes,
    _backgroundTranscodes: () => backgroundTranscodes
};
