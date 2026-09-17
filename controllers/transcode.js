// Shared "resolve a remote audio URL, transcode it with ffmpeg, stream MP3 to
// the client, and keep a disk-cache copy" pipeline. Used by every source that
// plays through the server (YouTube via yt-dlp, SoundCloud via its streams
// endpoint). Cache files are named `<cacheKey>.mp3`; callers pick a key that
// cannot collide across sources (YouTube keeps its bare 11-char id, SoundCloud
// uses `soundcloud_<id>`).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const cacheDir = path.join(__dirname, '../cache');
const resolvedCacheDir = path.resolve(cacheDir);

const MAX_SEEK_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_TRANSCODE_MS = 10 * 60 * 1000; // never let a transcode run longer than this
const MIN_CACHE_BYTES = 100000; // smaller output means a broken/partial download
const MAX_CACHE_FILES = 50;

// Cache keys currently being written, so two concurrent plays of the same
// track do not both try to produce the same cache file.
const inFlightCaching = new Set();

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
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

function manageAudioCache(maxFiles = MAX_CACHE_FILES) {
    fs.readdir(cacheDir, (err, files) => {
        if (err) return console.error('Error reading cache directory:', err);

        const audioFiles = files.filter(f => f.endsWith('.m4a') || f.endsWith('.mp3'));
        if (audioFiles.length <= maxFiles) return;

        const filesWithStats = audioFiles.map(file => {
            const fullPath = path.join(cacheDir, file);
            return { path: fullPath, time: fs.statSync(fullPath).mtime.getTime() };
        });
        filesWithStats.sort((a, b) => a.time - b.time);

        filesWithStats.slice(0, filesWithStats.length - maxFiles).forEach(fileObj => {
            fs.unlink(fileObj.path, err => {
                if (err) console.error(`Failed to delete old cache file: ${fileObj.path}`, err);
            });
        });
    });
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
    res.sendFile(finalFilePath);
    return true;
}

/**
 * Transcodes `sourceUrl` to MP3 and streams it into `res`. When `seekTime` is 0
 * and `allowCache` is true, a copy is written to the disk cache under
 * `cacheKey` once the transcode completes successfully.
 */
function streamTranscoded(req, res, { sourceUrl, cacheKey, seekTime = 0, allowCache = true }) {
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

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
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
    req.on('close', () => {
        ffmpegProcess.stdout.unpipe(res);
        if (!fileStream) {
            ffmpegProcess.kill('SIGKILL');
        }
    });

    ffmpegProcess.on('close', (code) => {
        finished = true;
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
                    manageAudioCache(MAX_CACHE_FILES);
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
    manageAudioCache
};
