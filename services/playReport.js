// What happened to the last few plays: how long each took to produce sound and
// what that time was made of, or why it failed.
//
// The same facts go to the log (controllers/transcode.js, logPlay), but a log
// has to be found, copied and read. This keeps the recent ones in memory so
// the app can show them: the reason next to "could not be played", and a
// short list under Settings -> System. It is also how the remaining tuning of
// yt-dlp gets its figures (docs/performance-plan.md, step 1.5).
//
// One entry per request for audio that a person would notice: not the
// requests that only prepare the next track, and not the follow-up requests a
// browser makes for further parts of a file it is already playing.
const MAX_ENTRIES = 60;
const MAX_REASON_CHARS = 300;

const entries = []; // oldest first
const byResponse = new WeakMap(); // res -> its entry
let counter = 0;

// eslint-disable-next-line no-control-regex
const tidy = (text) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);

function add(entry) {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    return entry;
}

/** Whether a request is one to keep an entry for. */
function worthRecording(req) {
    const query = (req && req.query) || {};
    if (query.prepare === '1') return false;
    const range = req && req.headers && req.headers.range;
    return !range || /^bytes=0-/.test(range);
}

/**
 * Starts the entry for a /stream request and settles it when the response
 * ends: with what the handlers reported meanwhile (playing(), reason()), or
 * else from how the response went.
 */
function begin(req, res, { source, id }) {
    if (!worthRecording(req)) return null;
    const startedAt = Date.now();
    const seek = Number(req.query && req.query.seek) || 0;
    const entry = add({
        n: ++counter,
        at: startedAt,
        userId: req.userId ?? null,
        source: tidy(source).slice(0, 32),
        id: tidy(id).slice(0, 64),
        seek,
        status: 'waiting', // waiting | playing | failed | left
        ms: null,          // to the first sound, or to the failure
        addressMs: null,   // the look-up of the audio address, when there was one
        addressFrom: null, // yt-dlp | shared | memory | api
        how: null,         // cache | conversion | joined | file
        reason: null
    });
    byResponse.set(res, entry);

    // An error answer is JSON; its message is the reason unless a handler gave a better one.
    const json = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 400 && !entry.reason && body && typeof body === 'object') {
            entry.reason = tidy([body.error, body.reason && `(${body.reason})`].filter(Boolean).join(' '));
        }
        return json(body);
    };
    const settle = () => {
        if (entry.status !== 'waiting') return;
        entry.ms = Date.now() - startedAt;
        if (res.statusCode >= 400 || entry.failed) {
            entry.status = 'failed';
            if (!entry.reason) entry.reason = `the server answered ${res.statusCode}`;
        } else if (res.writableFinished) {
            // Sent in full with nothing reported: a file passed on as it is.
            entry.status = 'playing';
            entry.how = entry.how || 'file';
        } else {
            entry.status = 'left'; // the listener moved on before any sound
        }
        delete entry.failed;
    };
    res.once('finish', settle);
    res.once('close', settle);
    return entry;
}

/** The handlers say sound is on its way, and what the wait was made of. */
function playing(res, { addressMs = null, addressFrom = null, how = null } = {}) {
    const entry = res && byResponse.get(res);
    if (!entry || entry.status !== 'waiting') return;
    entry.status = 'playing';
    entry.ms = Date.now() - entry.at;
    if (Number.isFinite(addressMs)) entry.addressMs = Math.round(addressMs);
    entry.addressFrom = addressFrom || null;
    entry.how = how;
}

/** Why this play is failing, in the words of whatever failed (yt-dlp, ffmpeg, a service). */
function reason(res, text, { failed = false } = {}) {
    const entry = res && byResponse.get(res);
    if (!entry || entry.status !== 'waiting') return;
    const clean = tidy(text);
    if (clean) entry.reason = clean;
    if (failed) entry.failed = true; // the response itself will look fine (an empty stream)
}

/**
 * A request turned away before it reached a handler (the rate limit). Nobody
 * has been identified at that point, so it belongs to no account, and a burst
 * of them is one entry (the latest), not sixty that push everything else out.
 */
function rejected(req, text) {
    const query = (req && req.query) || {};
    const last = entries[entries.length - 1];
    if (last && last.turnedAway) entries.pop();
    add({
        n: ++counter, at: Date.now(), userId: null,
        source: tidy(query.source || 'youtube').toLowerCase().slice(0, 32), id: tidy(query.videoId || '').slice(0, 64), seek: 0,
        status: 'failed', ms: 0, addressMs: null, addressFrom: null, how: null, reason: tidy(text), turnedAway: true
    });
}

/**
 * The latest entries, newest first. `userId`: only that account's (and those
 * that belong to nobody); null: everyone's (the installation's owner).
 */
function recent({ userId = null, limit = 20, source, id } = {}) {
    const max = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 20));
    return entries
        .filter((e) => (userId === null || e.userId === null || e.userId === userId)
            && (!source || e.source === source) && (!id || e.id === String(id)))
        .slice(-max)
        .reverse()
        .map(({ failed, turnedAway, userId: owner, ...shown }) => shown); // eslint-disable-line no-unused-vars
}

// Tests only.
function _reset() {
    entries.length = 0;
    counter = 0;
}

module.exports = { begin, playing, reason, rejected, recent, MAX_ENTRIES, _reset };
