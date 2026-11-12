// Local files (issue #24): folder management and playback.
//
// Folders (login required):
//   GET    /api/local/folders               list, with scan status
//   POST   /api/local/folders { path }      add one and start scanning it
//   POST   /api/local/folders/:id/rescan
//   DELETE /api/local/folders/:id
// Playback (media token, like every source): /stream and /duration with
// source=local&videoId=<track id>. The file must belong to the token's user
// and still be inside its folder (services/localLibrary.js). MP3, M4A, AAC,
// FLAC and WAV are sent as they are (HTTP range, native seeking, original
// quality); other formats, and any seek into a part not yet loaded, go
// through ffmpeg.
const library = require('../services/localLibrary');
const { parseSeek, sendMediaFile, streamTranscoded, isPrepare, answerPrepare } = require('./transcode');
const { sendSourceError } = require('../services/errors');

function sendLocalError(res, err, next) {
    if (err instanceof library.LocalError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    return next(err);
}

const listFolders = async (req, res, next) => {
    try {
        res.json({ folders: await library.listFolders(req.app.locals.db, req.userId) });
    } catch (err) { next(err); }
};

const addFolder = async (req, res, next) => {
    try {
        const folder = await library.addFolder(req.app.locals.db, req.userId, (req.body || {}).path);
        res.status(201).json(folder);
    } catch (err) { sendLocalError(res, err, next); }
};

const rescanFolder = async (req, res, next) => {
    try {
        await library.rescanFolder(req.app.locals.db, req.userId, req.params.id);
        res.status(202).json({ scanning: true });
    } catch (err) { sendLocalError(res, err, next); }
};

const removeFolder = async (req, res, next) => {
    try {
        await library.removeFolder(req.app.locals.db, req.userId, req.params.id);
        res.status(204).end();
    } catch (err) { sendLocalError(res, err, next); }
};

async function fileFor(req, res) {
    const id = req.query.videoId;
    if (!id || !/^[0-9]{1,12}$/.test(String(id))) {
        res.status(400).json({ error: 'Invalid videoId' });
        return null;
    }
    const file = await library.resolvePlayableFile(req.app.locals.db, req.userId, id);
    if (!file) {
        sendSourceError(res, 'TRACK_UNAVAILABLE', 'local', { status: 404, reason: 'file_missing' });
        return null;
    }
    return file;
}

const streamTrack = async (req, res, next) => {
    try {
        const { seekTime, error: seekError } = parseSeek(req.query.seek);
        if (seekError) return res.status(400).json({ error: seekError });
        const file = await fileFor(req, res);
        if (!file) return;
        // A file on this disk needs no preparing before it plays.
        if (isPrepare(req)) return answerPrepare(res, 'skipped');
        if (file.directType && seekTime === 0) return sendMediaFile(res, file.filePath, file.directType);
        // `file:` so a path is never read as a URL or an option by ffmpeg.
        return streamTranscoded(req, res, {
            sourceUrl: `file:${file.filePath}`,
            cacheKey: `local_${req.query.videoId}`,
            seekTime,
            allowCache: false
        });
    } catch (err) { next(err); }
};

const getDuration = async (req, res, next) => {
    try {
        const file = await fileFor(req, res);
        if (!file) return;
        res.json({ duration: file.durationSec || 0 });
    } catch (err) { next(err); }
};

module.exports = { listFolders, addFolder, rescanFolder, removeFolder, streamTrack, getDuration };
