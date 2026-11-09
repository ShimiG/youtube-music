// HTTP API of the match engine (services/matcher). Every route runs behind
// requireAuth. Validation failures are 400 MATCH_BAD_REQUEST; a source that is
// not in match mode is 400 MATCH_BAD_SOURCE, and the name is never echoed back
// (that is how a reflected payload would reach a browser).
//
//   GET    /api/match/:source/:id      the stored match, or 404 MATCH_NOT_FOUND
//   POST   /api/match/resolve          { tracks: Track[] } -> { results, summary }
//   POST   /api/match/override         { source, id, videoId } -> 204
//
// A client-supplied `isrc` is dropped on both resolve and override: the engine
// copies matches between tracks that share an ISRC, so accepting one from the
// browser would let a caller attach any video to any other track (match
// poisoning). Only provider-supplied tracks carry an ISRC into the engine.
//   POST   /api/match/report           { source, id, reason, videoId?, note? } -> 204
//   DELETE /api/match/:source/:id      forget the row so the next read re-resolves -> 204
const matcher = require('../services/matcher');

const MAX_TRACKS = 100;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 300;
const MAX_TEXT_LENGTH = 300;   // artist, album
const MAX_ARTISTS = 20;
const MAX_NOTE_LENGTH = 500;
const REPORT_REASONS = new Set(['wrong_match', 'unavailable', 'other']);

// Same alphabet as /stream?videoId= enforces, so a row we store can always be
// played back. Spotify ids are 22 base62 chars; other match sources use digits.
const EXTERNAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
// Matches the provider registry's name rule, so a malformed name is refused
// before it is used as a lookup key anywhere.
const SOURCE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function badRequest(res, error) {
    return res.status(400).json({ error, code: 'MATCH_BAD_REQUEST' });
}

function badSource(res) {
    return res.status(400).json({ error: 'Matching is not available for this source', code: 'MATCH_BAD_SOURCE' });
}

function isMatchSourceName(source) {
    return typeof source === 'string' && SOURCE_NAME.test(source) && matcher.isMatchSource(source);
}

function isExternalId(id) {
    return typeof id === 'string' && id.length <= MAX_ID_LENGTH && EXTERNAL_ID.test(id);
}

function isOptionalText(value, max) {
    return value === undefined || value === null || (typeof value === 'string' && value.length <= max);
}

// Reads the (:source, :id) pair shared by GET and DELETE. Sends the error
// response itself and returns null when the pair is unusable.
function readSourceAndId(req, res) {
    const { source, id } = req.params;
    if (!isMatchSourceName(source)) {
        badSource(res);
        return null;
    }
    if (!isExternalId(id)) {
        badRequest(res, 'Invalid track id');
        return null;
    }
    return { source, id };
}

// Validates one track of a resolve request and returns a copy that holds only
// the fields the engine reads, so client-supplied extras never reach it.
// Returns { error } or { badSource: true } on failure.
function cleanTrack(raw, index) {
    const at = `tracks[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} must be an object` };
    if (!isMatchSourceName(raw.source)) return { badSource: true };
    if (!isExternalId(raw.id)) return { error: `${at}.id is required (1-${MAX_ID_LENGTH} URL-safe characters)` };
    if (typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > MAX_TITLE_LENGTH) {
        return { error: `${at}.title is required (1-${MAX_TITLE_LENGTH} characters)` };
    }
    if (!isOptionalText(raw.artist, MAX_TEXT_LENGTH)) return { error: `${at}.artist must be a string of at most ${MAX_TEXT_LENGTH} characters` };
    if (!isOptionalText(raw.album, MAX_TEXT_LENGTH)) return { error: `${at}.album must be a string of at most ${MAX_TEXT_LENGTH} characters` };
    if (raw.artists !== undefined && raw.artists !== null) {
        const ok = Array.isArray(raw.artists)
            && raw.artists.length <= MAX_ARTISTS
            && raw.artists.every(a => typeof a === 'string' && a.length > 0 && a.length <= MAX_TEXT_LENGTH);
        if (!ok) return { error: `${at}.artists must be an array of at most ${MAX_ARTISTS} strings` };
    }
    if (raw.durationSec !== undefined && raw.durationSec !== null) {
        const n = Number(raw.durationSec);
        if (!Number.isFinite(n) || n < 0) return { error: `${at}.durationSec must be a non-negative number` };
    }
    if (raw.explicit !== undefined && raw.explicit !== null && typeof raw.explicit !== 'boolean') {
        return { error: `${at}.explicit must be a boolean` };
    }

    const track = {
        source: raw.source,
        id: raw.id,
        title: raw.title,
        artist: raw.artist || null,
        album: raw.album || null,
        durationSec: raw.durationSec === undefined || raw.durationSec === null ? null : Math.round(Number(raw.durationSec))
    };
    if (Array.isArray(raw.artists) && raw.artists.length) track.artists = raw.artists;
    if (typeof raw.explicit === 'boolean') track.explicit = raw.explicit;
    return { track };
}

// Only what the player needs; the full candidate list is on GET /api/match/:source/:id.
function publicResult(result) {
    return {
        status: result.status,
        videoId: result.videoId || null,
        score: Number.isFinite(result.score) ? result.score : null,
        method: result.method || null
    };
}

// Same shape filterPlayable reports for a list, so the client can treat a
// resolve response and a library page alike. `hidden` counts every track the
// product rule would keep out of a listing (anything not matched).
function summarize(results) {
    const summary = { total: 0, matched: 0, hidden: 0, pending: 0, errors: 0 };
    for (const r of results) {
        summary.total += 1;
        if (r.status === 'matched') summary.matched += 1;
        else summary.hidden += 1;
        if (r.status === 'pending') summary.pending += 1;
        if (r.status === 'error') summary.errors += 1;
    }
    return summary;
}

// --- GET /api/match/:source/:id ---------------------------------------------------

const getMatch = async (req, res, next) => {
    const pair = readSourceAndId(req, res);
    if (!pair) return;
    try {
        const row = await matcher.getMatch(req.app.locals.db, pair.source, pair.id);
        if (!row) return res.status(404).json({ error: 'No match recorded for this track', code: 'MATCH_NOT_FOUND' });
        res.json({
            source: pair.source,
            id: pair.id,
            status: row.status,
            videoId: row.videoId || null,
            score: Number.isFinite(row.score) ? row.score : null,
            method: row.method || null,
            candidates: Array.isArray(row.candidates) ? row.candidates : [],
            checkedAt: row.checkedAt ?? null,
            manual: Boolean(row.manual)
        });
    } catch (err) {
        next(err);
    }
};

// --- POST /api/match/resolve -------------------------------------------------------

const resolveTracks = async (req, res, next) => {
    const { tracks } = req.body || {};
    if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > MAX_TRACKS) {
        return badRequest(res, `tracks must be an array of 1-${MAX_TRACKS} items`);
    }

    const clean = [];
    for (let i = 0; i < tracks.length; i++) {
        const checked = cleanTrack(tracks[i], i);
        if (checked.badSource) return badSource(res);
        if (checked.error) return badRequest(res, checked.error);
        clean.push(checked.track);
    }

    try {
        const resolved = await matcher.resolveMany(req.app.locals.db, clean);
        const results = {};
        for (const track of clean) {
            const key = matcher.keyOf(track);
            // A key the engine did not report (should not happen) is still pending
            // from the client's point of view: it has nothing to play yet.
            results[key] = publicResult(resolved.get(key) || { status: 'pending' });
        }
        res.json({ results, summary: summarize(Object.values(results)) });
    } catch (err) {
        next(err);
    }
};

// --- POST /api/match/override ------------------------------------------------------

const override = async (req, res, next) => {
    const { source, id, videoId } = req.body || {};
    if (!isMatchSourceName(source)) return badSource(res);
    if (!isExternalId(id)) return badRequest(res, 'Invalid track id');
    if (typeof videoId !== 'string' || !YOUTUBE_ID.test(videoId)) return badRequest(res, 'videoId must be an 11-character YouTube id');

    try {
        await matcher.setOverride(req.app.locals.db, { source, externalId: id, videoId, userId: req.userId });
        res.status(204).end();
    } catch (err) {
        next(err);
    }
};

// --- POST /api/match/report ---------------------------------------------------------

const report = async (req, res, next) => {
    const { source, id, reason, videoId, note } = req.body || {};
    if (!isMatchSourceName(source)) return badSource(res);
    if (!isExternalId(id)) return badRequest(res, 'Invalid track id');
    if (typeof reason !== 'string' || !REPORT_REASONS.has(reason)) {
        return badRequest(res, 'reason must be one of wrong_match, unavailable, other');
    }
    if (videoId !== undefined && videoId !== null && (typeof videoId !== 'string' || !YOUTUBE_ID.test(videoId))) {
        return badRequest(res, 'videoId must be an 11-character YouTube id');
    }
    if (!isOptionalText(note, MAX_NOTE_LENGTH)) return badRequest(res, `note must be a string of at most ${MAX_NOTE_LENGTH} characters`);

    try {
        await matcher.report(req.app.locals.db, {
            source,
            externalId: id,
            userId: req.userId,
            reason,
            videoId: videoId || null,
            note: note || null
        });
        res.status(204).end();
    } catch (err) {
        next(err);
    }
};

// --- DELETE /api/match/:source/:id --------------------------------------------------

// The engine owns the row (and the in-flight bookkeeping that goes with it),
// so forgetting goes through it rather than through SQL from here.
const forget = async (req, res, next) => {
    const pair = readSourceAndId(req, res);
    if (!pair) return;
    try {
        await matcher.forget(req.app.locals.db, pair.source, pair.id);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
};

module.exports = { getMatch, resolveTracks, override, report, forget };
