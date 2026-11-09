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

// Streams the YouTube video `videoId` into `res`. Shared by the YouTube source
// (id straight from the query string) and by the match-mode sources, whose
// handler looks the id up in track_matches first (controllers/matchedStream.js).
// Taking the id as an argument instead of reading req.query keeps callers from
// having to mutate the request, and the cache key stays the bare YouTube id,
// so a Spotify play and a YouTube play of the same video share one cache file.
function streamVideo(req, res, videoId) {
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
// (ours below and the match-mode one) decide how to report that.
function durationOf(videoId) {
    if (!isValidVideoId(videoId)) return Promise.reject(new Error('Invalid videoId'));
    if (durationCache.has(videoId)) return Promise.resolve(durationCache.get(videoId));

    const args = ['--print', 'duration', `https://www.youtube.com/watch?v=${videoId}`];

    return new Promise((resolve, reject) => {
        execFile(ytDlpPath, args, (error, stdout) => {
            if (error) return reject(error);
            const durationInSeconds = parseInt(stdout.trim(), 10) || 0;
            if (durationCache.size >= DURATION_CACHE_MAX) {
                durationCache.delete(durationCache.keys().next().value);
            }
            durationCache.set(videoId, durationInSeconds);
            resolve(durationInSeconds);
        });
    });
}

const getDuration = (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

    return durationOf(videoId)
        .then((duration) => res.json({ duration }))
        .catch(() => res.status(502).json({ duration: 0 }));
};

module.exports = { streamTrack, getDuration, streamVideo, durationOf, isValidVideoId };
