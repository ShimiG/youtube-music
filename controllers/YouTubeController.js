const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const cacheDir = path.join(__dirname, '../cache');
const isWindows = process.platform === 'win32';
const ffmpegPath = require('ffmpeg-static');
const ytDlpPath = path.join(__dirname, '../bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp_macos');

const resolvedCacheDir = path.resolve(cacheDir);
const MAX_SEEK_SECONDS = 24 * 60 * 60; // 24 hours, adjust as needed
const MAX_TRANSCODE_MS = 10 * 60 * 1000; // safety cap: never let a transcode run longer than this

// videoIds currently being written to the disk cache, so two concurrent plays
// of the same track do not both try to produce the same cache file.
const inFlightCaching = new Set();

// Small in-memory cache for /duration so we do not spawn yt-dlp for a track we
// already looked up. Bounded to avoid unbounded growth.
const durationCache = new Map();
const DURATION_CACHE_MAX = 500;

/**
 * Derive a safe filename component from a videoId by allowing only
 * alphanumeric characters, dash and underscore, and trimming length.
 */
function toSafeFilenameComponent(videoId) {
    if (typeof videoId !== 'string') {
        return 'unknown';
    }
    const sanitized = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return sanitized.substring(0, 64) || 'unknown';
}

if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

function isValidVideoId(videoId) {
    return typeof videoId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(videoId);
}

function manageAudioCache(maxFiles = 50) {
    fs.readdir(cacheDir, (err, files) => {
        if (err) return console.error('Error reading cache directory:', err);

        const audioFiles = files.filter(f => f.endsWith('.m4a') || f.endsWith('.mp3'));

        if (audioFiles.length > maxFiles) {
            const filesWithStats = audioFiles.map(file => {
                const fullPath = path.join(cacheDir, file);
                return { path: fullPath, time: fs.statSync(fullPath).mtime.getTime() };
            });

            filesWithStats.sort((a, b) => a.time - b.time);
            const filesToDelete = filesWithStats.slice(0, filesWithStats.length - maxFiles);

            filesToDelete.forEach(fileObj => {
                fs.unlink(fileObj.path, err => {
                    if (err) console.error(`Failed to delete old cache file: ${fileObj.path}`, err);
                });
            });
        }
    });
}

const streamTrack = async (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId || videoId === 'undefined') {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    if (!isValidVideoId(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    const rawSeek = req.query.seek;
    let seekTime = 0;
    if (rawSeek !== undefined) {
        const parsedSeek = Number(rawSeek);
        if (!Number.isFinite(parsedSeek)) {
            return res.status(400).json({ error: 'Invalid seek parameter' });
        }
        seekTime = Math.floor(parsedSeek);
        if (seekTime < 0 || seekTime > MAX_SEEK_SECONDS) {
            return res.status(400).json({ error: 'Invalid seek parameter' });
        }
    }

    const finalFilePath = path.resolve(resolvedCacheDir, `${videoId}.mp3`);
    if (!finalFilePath.startsWith(resolvedCacheDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    // Cache hit: sendFile supports HTTP Range natively, so the browser can seek.
    if (fs.existsSync(finalFilePath)) {
        const now = new Date();
        fs.utimes(finalFilePath, now, now, () => {});
        return res.sendFile(finalFilePath);
    }

    const args = ['-g', `https://www.youtube.com/watch?v=${videoId}`];

    execFile(ytDlpPath, args, (error, stdout) => {
        if (error) {
            if (!res.headersSent) res.status(502).json({ error: 'Could not resolve audio source' });
            return;
        }

        const audioUrl = stdout.trim();
        if (!audioUrl) {
            if (!res.headersSent) res.status(502).json({ error: 'No audio URL found' });
            return;
        }

        const ffmpegArgs = [
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-ss', seekTime.toString(),
            '-i', audioUrl,
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
        const shouldCache = seekTime === 0 && !inFlightCaching.has(videoId);
        if (shouldCache) {
            const uniquePartId = `${toSafeFilenameComponent(videoId)}_${Date.now()}.part`;
            const candidatePartPath = path.resolve(cacheDir, uniquePartId);
            if (candidatePartPath.startsWith(resolvedCacheDir + path.sep)) {
                safePartFilePath = candidatePartPath;
                inFlightCaching.add(videoId);
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
        // caching this stream, there is no reason to keep transcoding — kill it
        // so the process does not linger. If we ARE caching, let it finish so the
        // file lands in the cache for next time (the safety timer still bounds it).
        req.on('close', () => {
            ffmpegProcess.stdout.unpipe(res);
            if (!fileStream) {
                ffmpegProcess.kill('SIGKILL');
            }
        });

        ffmpegProcess.on('close', (code) => {
            finished = true;
            clearTimeout(cleanupTimer);
            inFlightCaching.delete(videoId);
            if (!fileStream) return;

            fileStream.end();
            setTimeout(() => {
                if (!safePartFilePath || !fs.existsSync(safePartFilePath)) return;
                const stats = fs.statSync(safePartFilePath);
                if (code === 0 && stats.size > 100000) {
                    if (!fs.existsSync(finalFilePath)) {
                        fs.renameSync(safePartFilePath, finalFilePath);
                        manageAudioCache(50);
                    } else {
                        fs.unlinkSync(safePartFilePath);
                    }
                } else {
                    // Broken/partial download — never leave a .part file behind.
                    fs.unlinkSync(safePartFilePath);
                }
            }, 250);
        });
    });
};

const getDuration = (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

    if (durationCache.has(videoId)) {
        return res.json({ duration: durationCache.get(videoId) });
    }

    const args = ['--print', 'duration', `https://www.youtube.com/watch?v=${videoId}`];

    execFile(ytDlpPath, args, (error, stdout) => {
        if (error) {
            return res.status(502).json({ duration: 0 });
        }
        const durationInSeconds = parseInt(stdout.trim(), 10) || 0;
        if (durationCache.size >= DURATION_CACHE_MAX) {
            durationCache.delete(durationCache.keys().next().value);
        }
        durationCache.set(videoId, durationInSeconds);
        res.json({ duration: durationInSeconds });
    });
};

module.exports = { streamTrack, getDuration };
