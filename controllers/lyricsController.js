// Lyrics for the playing track (issue #30):
//   GET /api/lyrics?source=&id=&title=&artist=&duration=&online=1
// `online=1` says the user agreed to look lyrics up on LRCLIB; without it only
// lyrics kept with the user's own files are returned. See services/lyrics.js
// for the answer's shape.
const lyrics = require('../services/lyrics');

// Query values can arrive as arrays or objects (?title[]=x); only text counts.
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const getLyrics = async (req, res, next) => {
    try {
        const source = text(req.query.source, 20).toLowerCase();
        if (!/^[a-z]{2,20}$/.test(source)) {
            return res.status(400).json({ error: 'source is required.' });
        }
        const duration = Number(text(req.query.duration, 12));
        const result = await lyrics.getLyrics(req.app.locals.db, req.userId, {
            source,
            id: text(req.query.id, 200),
            title: text(req.query.title, 300),
            artist: text(req.query.artist, 200),
            durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
            online: req.query.online === '1'
        });
        res.set('Cache-Control', 'no-store');
        return res.json(result);
    } catch (err) {
        return next(err);
    }
};

module.exports = { getLyrics };
