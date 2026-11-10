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

// Cache keys currently being written, so two concurrent plays of the same
// track do not both try to produce the same cache file.
const inFlightCaching = new Set();

// A transcode that is writing the cache keeps running after its client leaves,
// so the file is ready next time. That must be bounded, or anything that can
// make the browser request /stream (any web page, via <audio>) can pile up
// ffmpeg processes. Beyond this many, abandoned transcodes are killed.
const MAX_BACKGROUND_TRANSCODES = 2;
let backgroundTranscodes = 0;

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

/**
 * Serves the cached MP3 for `cacheKey` if one exists (with HTTP Range support
 * via sendFile, so the browser can seek). Returns true when it did.
 */
function serveFromCache(res, cacheKey) {
    const finalFilePath = cachePathFor(cacheKey);
    if (!finalFilePath || !fs.existsSync(finalFilePath)) return false;
    const now = new Date();
    fs.utimes(finalFilePath, now, now, () => {});
    setMediaHeaders(res);
    res.sendFile(finalFilePath);
    return true;
}

/**
 * Transcodes `sourceUrl` to MP3 and streams it into `res`. When `seekTime` is 0
 * and `allowCache` is true, a copy is written to the disk cache under
 * `cacheKey` once the transcode completes successfully.
 */
function streamTranscoded(_req, res, { sourceUrl, cacheKey, seekTime = 0, allowCache = true }) {
    const finalFilePath = cachePathFor(cacheKey);

    const ffmpegArgs = [
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-ss', seekTime.toString(),
        '-i', sourceUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        '-f', 'mp3',
        '-'
    ];

    // windowsHide: the desktop app has no console; without it every transcode
    // would flash a console window on Windows.
    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true });
    let finished = false;

    // One place that guarantees the child process is gone. Called on error,
    // on completion, on client disconnect, and by the safety timeout.
    const cleanupTimer = setTimeout(() => {
        if (!finished) ffmpegProcess.kill('SIGKILL');
    }, MAX_TRANSCODE_MS);

    ffmpegProcess.on('error', (err) => {
        console.error('Failed to start FFmpeg:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Audio processor unavailable' });
    });

    setMediaHeaders(res);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    ffmpegProcess.stdout.pipe(res);

    // Only write a disk-cache copy for a full (seek==0) play, and only if no
    // other request is already caching this track.
    let fileStream = null;
    let safePartFilePath = null;
    const shouldCache = allowCache && finalFilePath && seekTime === 0 && !inFlightCaching.has(cacheKey);
    if (shouldCache) {
        const candidatePartPath = path.resolve(cacheDir, `${cacheKey}_${Date.now()}.part`);
        if (candidatePartPath.startsWith(resolvedCacheDir + path.sep)) {
            safePartFilePath = candidatePartPath;
            inFlightCaching.add(cacheKey);
            fileStream = fs.createWriteStream(safePartFilePath);
            ffmpegProcess.stdout.pipe(fileStream);
        }
    }

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
    let inBackground = false;
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

    ffmpegProcess.on('close', (code) => {
        finished = true;
        if (inBackground) backgroundTranscodes--;
        clearTimeout(cleanupTimer);
        inFlightCaching.delete(cacheKey);
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
}

module.exports = {
    cacheDir,
    isValidCacheKey,
    parseSeek,
    serveFromCache,
    streamTranscoded,
    enforceCacheLimit,
    prepareCache,
    cacheMaxBytes,
    MAX_BACKGROUND_TRANSCODES,
    _backgroundTranscodes: () => backgroundTranscodes
};
