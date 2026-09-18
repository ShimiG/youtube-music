const { execFile } = require('child_process');
const { parseSeek, serveFromCache, streamTranscoded } = require('./transcode');
const { ytDlpPath } = require('../services/ytdlp');

// Small in-memory cache for /duration so we do not spawn yt-dlp for a track we
// already looked up. Bounded to avoid unbounded growth.
const durationCache = new Map();
const DURATION_CACHE_MAX = 500;

// YouTube video ids are always exactly 11 URL-safe characters. Being strict
// here also keeps YouTube cache files (`<id>.mp3`) from ever colliding with
// other sources' prefixed keys (`soundcloud_<id>.mp3`).
function isValidVideoId(videoId) {
    return typeof videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

const streamTrack = async (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId || videoId === 'undefined') {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    if (!isValidVideoId(videoId)) {
        return res.status(400).json({ error: 'Invalid videoId' });
    }

    const { seekTime, error: seekError } = parseSeek(req.query.seek);
    if (seekError) return res.status(400).json({ error: seekError });

    // Cache hit: sendFile supports HTTP Range natively, so the browser can seek.
    if (serveFromCache(res, videoId)) return;

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

        streamTranscoded(req, res, { sourceUrl: audioUrl, cacheKey: videoId, seekTime });
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

module.exports = { streamTrack, getDuration, isValidVideoId };
