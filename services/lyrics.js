// Lyrics for the playing track (issue #30, ROADMAP Stage 7).
//
// Two places are looked in, in this order:
//   1. The user's own files (source "local"): a .lrc file next to the audio
//      file, then lyrics stored in the file's tags. Nothing leaves the computer.
//   2. LRCLIB (https://lrclib.net), a free, open lyrics database with timed
//      lyrics and no API key. A lookup sends the track's title, artist and
//      length to that server, so it only happens when the caller says the user
//      agreed (`online`), and LYRICS_ONLINE=off turns it off for everyone.
//
// The answer always has the same shape:
//   { status, synced, plain, origin, credit }
//   status  found | instrumental | not_found | online_disabled | unavailable
//   synced  [{ t (seconds), text }] in time order, or null
//   plain   the lyrics as text, or null
//   origin  file | tags | lrclib
// Online answers are cached in lyrics_cache, "not found" included, so a track
// is asked about once; failures (network, rate limit) are never cached.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pkg = require('../package.json');
const localLibrary = require('./localLibrary');
const tagReader = require('./tagReader');
const { sameArtist } = require('./matcher/normalize');

const PROVIDER = 'lrclib';
const CREDIT = { name: 'LRCLIB', url: 'https://lrclib.net' };
const DEFAULT_BASE_URL = 'https://lrclib.net';
// LRCLIB asks clients to say who they are.
const CLIENT_ID = `MusicManager/${pkg.version}`;

const TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 60000;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 300;
// LRCLIB's own exact lookup allows 2 s either way; a little more is still in
// time with the music. Beyond that the timestamps belong to another cut of
// the song, so only the words are used.
const SYNC_TOLERANCE_SEC = 3;
const MAX_LOOKUP_DURATION_SEC = 3600; // LRCLIB rejects longer values
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ROWS = 5000;
const PRUNE_EVERY = 50;
const DEFAULT_PAUSE_SEC = 60;
const MAX_PAUSE_SEC = 600;

// Wrapped so tests can stub the network call.
const http = { fetch: (...args) => fetch(...args) };

class LyricsUnavailable extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'LyricsUnavailable';
    }
}

const answer = (status, { synced = null, plain = null, origin = null, reason } = {}) => ({
    status,
    synced,
    plain,
    origin,
    credit: origin === PROVIDER ? CREDIT : null,
    ...(reason ? { reason } : {})
});

// --- Text -------------------------------------------------------------------

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanLine(text) {
    return collapse(String(text).replace(CONTROL_CHARS, ' ')).slice(0, MAX_LINE_CHARS);
}

/** Plain lyrics: normalised line ends, no control characters, size-capped. */
function cleanPlain(text) {
    if (typeof text !== 'string') return null;
    const out = text.slice(0, MAX_TEXT_CHARS)
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARS, ' ')
        .split('\n').map((line) => line.trimEnd()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return out || null;
}

/** Timed lines in order, cleaned and capped; null when none carries text. */
function normalizeLines(lines) {
    if (!Array.isArray(lines)) return null;
    const out = [];
    for (const line of lines) {
        if (!line || !Number.isFinite(line.t) || line.t < 0) continue;
        out.push({ t: Math.round(line.t * 100) / 100, text: cleanLine(line.text ?? '') });
        if (out.length >= MAX_LINES) break;
    }
    if (!out.some((line) => line.text)) return null;
    // Array.prototype.sort is stable: lines sharing a time keep their order.
    return out.sort((a, b) => a.t - b.t);
}

const plainOf = (synced) => cleanPlain(synced.map((line) => line.text).join('\n'));

const LEADING_TIME = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const WORD_TIME = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g; // "enhanced" LRC, per-word times
const OFFSET_TAG = /^\[offset:\s*([+-]?\d{1,7})\s*\]$/i;

/**
 * Parses LRC text into timed lines, or null when it has no timestamps.
 * Handles several timestamps on one line ("[00:12.00][01:15.30]Chorus"),
 * mm:ss, mm:ss.xx and mm:ss.xxx, per-word tags, and the [offset:] tag
 * (milliseconds; a positive value makes the lyrics appear earlier).
 */
function parseLrc(text) {
    if (typeof text !== 'string') return null;
    const lines = [];
    let offsetMs = 0;
    for (const raw of text.slice(0, MAX_TEXT_CHARS).split(/\r\n|\n|\r/)) {
        let rest = raw.trim();
        const offset = OFFSET_TAG.exec(rest);
        if (offset) {
            offsetMs = Number(offset[1]);
            continue;
        }
        const times = [];
        for (let m = LEADING_TIME.exec(rest); m; m = LEADING_TIME.exec(rest)) {
            const fraction = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
            times.push(Number(m[1]) * 60 + Number(m[2]) + fraction);
            rest = rest.slice(m[0].length).trimStart();
        }
        if (!times.length) continue; // [ar:...] and other tags, or untimed text
        const lineText = rest.replace(WORD_TIME, '');
        for (const t of times) lines.push({ t, text: lineText });
        if (lines.length >= MAX_LINES) break;
    }
    if (!lines.length) return null;
    const shift = offsetMs / 1000;
    return normalizeLines(lines.map((line) => ({ t: Math.max(0, line.t - shift), text: line.text })));
}

/** Lyrics from one piece of text that may or may not be LRC. */
function fromText(text, origin) {
    const synced = parseLrc(text);
    const plain = synced ? plainOf(synced) : cleanPlain(text);
    if (!synced && !plain) return null;
    return answer('found', { synced, plain, origin });
}

// --- The user's own files ---------------------------------------------------

function decodeText(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
        return body.swap16().toString('utf16le');
    }
    const decoded = buf.toString('utf8');
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

/**
 * The .lrc file beside an audio file ("Song.flac" -> "Song.lrc"), or null.
 * `audioPath` is the real path localLibrary already confined to the user's
 * folder. Only a regular file is read: a link is refused (O_NOFOLLOW where
 * the platform has it, and the check on the opened handle everywhere).
 */
async function readSidecar(audioPath) {
    const stem = audioPath.slice(0, audioPath.length - path.extname(audioPath).length);
    for (const ext of ['.lrc', '.LRC']) {
        let handle;
        try {
            const link = await fs.promises.lstat(stem + ext);
            if (!link.isFile()) continue;
            handle = await fs.promises.open(stem + ext, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SIDECAR_BYTES) continue;
            return decodeText(await handle.readFile());
        } catch {
            // missing or unreadable: try the next spelling
        } finally {
            if (handle) await handle.close().catch(() => {});
        }
    }
    return null;
}

async function localLyrics(db, userId, trackId) {
    const file = await localLibrary.resolvePlayableFile(db, userId, trackId);
    if (!file) return null;
    const sidecar = await readSidecar(file.filePath);
    const fromFile = sidecar ? fromText(sidecar, 'file') : null;
    if (fromFile) return fromFile;
    try {
        const tags = await tagReader.readLyrics(file.filePath);
        const synced = normalizeLines(tags.timed);
        if (synced) return answer('found', { synced, plain: plainOf(synced), origin: 'tags' });
        return tags.text ? fromText(tags.text, 'tags') : null;
    } catch {
        return null; // unreadable tags: the same as none
    }
}

// --- Online: what to ask for -------------------------------------------------

const BRACKETS = /[([{]([^()[\]{}]{0,80})[)\]}]/g;
const NOISE = /\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|remaster(?:ed)?|explicit|clean|prod|premiere)\b/i;
const FEATURE_START = /^(?:feat\.?|ft\.?|featuring|with) /i;
const TRAILING_FEATURE = / (?:feat\.?|ft\.?|featuring) .*$/i;
const DASH = / [-–—] /;

/**
 * Takes video decoration off a title while keeping its wording: "(Official
 * Video)", "[Lyrics]", "(feat. X)", "| Label", "- Remastered 2011", "ft. X".
 * Brackets that say something about the recording ("(Live)") are kept.
 */
function denoise(title) {
    let t = collapse(title).replace(BRACKETS, (whole, inner) => {
        const text = inner.trim();
        return NOISE.test(text) || FEATURE_START.test(`${text} `) ? ' ' : whole;
    });
    t = collapse(t).split(/ [|•] /)[0];
    const parts = t.split(DASH);
    while (parts.length > 1 && NOISE.test(parts[parts.length - 1])) parts.pop();
    return collapse(parts.join(' - ').replace(TRAILING_FEATURE, ''));
}

const stripBrackets = (title) => collapse(title.replace(BRACKETS, ' '));

/** "Daft Punk - Topic" and "Unknown Artist" are not artist names. */
function cleanArtist(artist) {
    const name = collapse(artist || '').replace(/ - Topic$/i, '');
    return /^unknown artist$/i.test(name) ? '' : name;
}

/**
 * The (title, artist) pairs worth asking about, most likely first, at most
 * three. A YouTube upload is often "Artist - Title (Official Video)" on a
 * channel that is not the artist's, so the part before the dash is tried as
 * the artist too: first for YouTube (`videoTitle`), second for catalogues
 * whose artist field can be trusted.
 */
function lookupCandidates(rawTitle, rawArtist, { videoTitle = false } = {}) {
    const artist = cleanArtist(rawArtist);
    const out = [];
    const seen = new Set();
    const add = (title, name) => {
        const t = collapse(title);
        const a = collapse(name);
        const key = `${t.toLowerCase()}\n${a.toLowerCase()}`;
        if (!t || !a || seen.has(key)) return;
        seen.add(key);
        out.push({ title: t, artist: a });
    };

    const parts = denoise(rawTitle || '').split(DASH);
    let own = parts.join(' - ');
    let named = artist;
    let uploaded = null;
    if (parts.length > 1) {
        const rest = parts.slice(1).join(' - ');
        if (artist && sameArtist(parts[0], artist)) {
            // The title spells the name properly ("Daft Punk"); the channel
            // may not ("DaftPunkVEVO").
            own = rest;
            named = cleanArtist(parts[0]) || artist;
        } else {
            uploaded = { title: rest, artist: cleanArtist(parts[0]) };
        }
    }
    if (uploaded && videoTitle) add(uploaded.title, uploaded.artist);
    if (named) add(own, named);
    if (uploaded) add(uploaded.title, uploaded.artist);
    if (named) {
        add(stripBrackets(own), named);
        // "Daft Punk, Pharrell Williams": the first credited name alone.
        add(own, named.split(/, | & | x | feat\.? | ft\.? /i)[0]);
    }
    return out.slice(0, 3);
}

// --- Online: LRCLIB -----------------------------------------------------------

const onlineEnabled = () => !/^(?:0|false|off|no)$/i.test(String(process.env.LYRICS_ONLINE || '').trim());

/** LRCLIB_URL points at another instance (it is self-hostable); http(s) only. */
function baseUrl() {
    const configured = String(process.env.LRCLIB_URL || '').trim();
    if (!configured) return DEFAULT_BASE_URL;
    try {
        const url = new URL(configured);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch { /* fall through */ }
    console.warn('LRCLIB_URL is not an http(s) URL; using the default lyrics server.');
    return DEFAULT_BASE_URL;
}

let pausedUntil = 0; // after a 429: no requests before this time

async function readJson(res) {
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_RESPONSE_BYTES) throw new LyricsUnavailable('The lyrics server sent too much data.');
    const chunks = [];
    let size = 0;
    if (res.body) {
        for await (const chunk of res.body) {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) throw new LyricsUnavailable('The lyrics server sent too much data.');
            chunks.push(chunk);
        }
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
        throw new LyricsUnavailable('The lyrics server sent an unreadable answer.', { cause: err });
    }
}

/** GET on LRCLIB. Resolves to the parsed body, or null for "no such track". */
async function lrclib(pathname, params) {
    if (Date.now() < pausedUntil) throw new LyricsUnavailable('The lyrics server asked us to slow down.');
    const url = new URL(pathname, baseUrl());
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let res;
    try {
        res = await http.fetch(url, {
            headers: { 'User-Agent': CLIENT_ID, 'Lrclib-Client': CLIENT_ID, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (err) {
        throw new LyricsUnavailable('The lyrics server could not be reached.', { cause: err });
    }
    if (res.status === 404) return null;
    if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after'));
        const seconds = Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_PAUSE_SEC) : DEFAULT_PAUSE_SEC;
        pausedUntil = Date.now() + seconds * 1000;
        throw new LyricsUnavailable('The lyrics server asked us to slow down.');
    }
    if (!res.ok) throw new LyricsUnavailable(`The lyrics server answered ${res.status}.`);
    return readJson(res);
}

/** An LRCLIB track -> our answer, or null when it holds no lyrics at all. */
function fromLrclib(track, useTimes) {
    if (!track || typeof track !== 'object') return null;
    if (track.instrumental === true) return answer('instrumental', { origin: PROVIDER });
    const timed = parseLrc(track.syncedLyrics);
    const plain = cleanPlain(track.plainLyrics) || (timed ? plainOf(timed) : null);
    const synced = useTimes ? timed : null;
    if (!synced && !plain) return null;
    return answer('found', { synced, plain, origin: PROVIDER });
}

// The comparison LRCLIB itself makes: case, accents and punctuation ignored.
const fold = (s) => collapse(String(s ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' '));

function artistFits(found, wanted) {
    const a = fold(found);
    const b = fold(wanted);
    if (!a || !b) return false;
    return a === b || sameArtist(found, wanted) || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

/**
 * Picks from search results: same title, same artist, closest in length.
 * Returns { track, useTimes }; times are only trusted when the length agrees
 * (or is unknown on our side).
 */
function pickSearchResult(results, wanted, durationSec) {
    const title = fold(wanted.title);
    const matches = results.filter((r) => r && typeof r === 'object'
        && fold(r.trackName ?? r.name) === title
        && artistFits(r.artistName, wanted.artist)
        && (r.instrumental === true || r.plainLyrics || r.syncedLyrics));
    if (!matches.length) return null;
    if (!durationSec) {
        return { track: matches.find((r) => r.syncedLyrics) || matches[0], useTimes: true };
    }
    const distance = (r) => (Number.isFinite(r.duration) ? Math.abs(r.duration - durationSec) : Infinity);
    const near = matches.filter((r) => distance(r) <= SYNC_TOLERANCE_SEC);
    if (near.length) {
        near.sort((a, b) => Boolean(b.syncedLyrics) - Boolean(a.syncedLyrics) || distance(a) - distance(b));
        return { track: near[0], useTimes: true };
    }
    // Another cut of the song: its words, not its timing, and not its claim
    // to be instrumental.
    const worded = matches.filter((r) => r.instrumental !== true).sort((a, b) => distance(a) - distance(b));
    return worded.length ? { track: worded[0], useTimes: false } : null;
}

async function fetchOnline({ source, title, artist, durationSec }) {
    const candidates = lookupCandidates(title, artist, { videoTitle: source === 'youtube' });
    if (!candidates.length) return answer('not_found');
    const duration = Number.isFinite(durationSec) && durationSec >= 1 && durationSec <= MAX_LOOKUP_DURATION_SEC
        ? Math.round(durationSec) : null;

    // The exact lookup first (cheap for the server), then one search each for
    // the two likeliest spellings.
    for (const c of candidates) {
        const hit = await lrclib('/api/get', { track_name: c.title, artist_name: c.artist, ...(duration ? { duration } : {}) });
        const result = fromLrclib(hit, true);
        if (result) return result;
    }
    for (const c of candidates.slice(0, 2)) {
        const list = await lrclib('/api/search', { track_name: c.title, artist_name: c.artist });
        const pick = Array.isArray(list) ? pickSearchResult(list, c, duration) : null;
        const result = pick ? fromLrclib(pick.track, pick.useTimes) : null;
        if (result) return result;
    }
    return answer('not_found');
}

// --- Online: cache ------------------------------------------------------------

function lookupKey({ source, title, artist, durationSec }) {
    const parts = [source === 'youtube' ? 'video' : 'track', collapse(title || '').toLowerCase(), collapse(artist || '').toLowerCase(), Number.isFinite(durationSec) ? Math.round(durationSec) : 0];
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function readCache(db, key) {
    const row = await db.get('SELECT status, synced, plain, provider, fetched_at FROM lyrics_cache WHERE lookup_key = ?', [key]);
    if (!row || row.provider !== PROVIDER) return null;
    const ttl = row.status === 'not_found' ? NOT_FOUND_TTL_MS : FOUND_TTL_MS;
    if (Date.now() - row.fetched_at > ttl) return null;
    if (row.status === 'not_found') return answer('not_found');
    if (row.status === 'instrumental') return answer('instrumental', { origin: PROVIDER });
    let synced = null;
    try { synced = row.synced ? normalizeLines(JSON.parse(row.synced)) : null; } catch { synced = null; }
    if (!synced && !row.plain) return null;
    return answer('found', { synced, plain: row.plain || null, origin: PROVIDER });
}

let writes = 0;

async function writeCache(db, key, result) {
    const now = Date.now();
    await db.run(
        `INSERT INTO lyrics_cache (lookup_key, status, synced, plain, provider, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(lookup_key) DO UPDATE SET
            status = excluded.status, synced = excluded.synced, plain = excluded.plain,
            provider = excluded.provider, fetched_at = excluded.fetched_at`,
        [key, result.status, result.synced ? JSON.stringify(result.synced) : null, result.plain, PROVIDER, now]
    );
    if (++writes % PRUNE_EVERY !== 0) return;
    await db.run('DELETE FROM lyrics_cache WHERE fetched_at < ?', [now - FOUND_TTL_MS]);
    await db.run(
        `DELETE FROM lyrics_cache WHERE lookup_key IN (
            SELECT lookup_key FROM lyrics_cache ORDER BY fetched_at DESC LIMIT -1 OFFSET ?)`,
        [MAX_CACHE_ROWS]
    );
}

const inFlight = new Map(); // lookup key -> Promise<answer>

async function onlineLyrics(db, track) {
    const key = lookupKey(track);
    const cached = await readCache(db, key);
    if (cached) return cached;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = fetchOnline(track)
        .then(async (result) => {
            await writeCache(db, key, result);
            return result;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
}

// --- Entry point --------------------------------------------------------------

/**
 * Lyrics for a track: { source, id, title, artist, durationSec, online }.
 * `online` says the user agreed to online lookups; without it only the
 * user's own files are read.
 */
async function getLyrics(db, userId, track) {
    if (track.source === 'local') {
        const local = await localLyrics(db, userId, track.id);
        if (local) return local;
    }
    if (!track.title) return answer('not_found');
    if (!onlineEnabled()) return answer('online_disabled', { reason: 'server' });
    if (!track.online) return answer('online_disabled', { reason: 'consent' });
    try {
        return await onlineLyrics(db, track);
    } catch (err) {
        if (!(err instanceof LyricsUnavailable)) throw err;
        console.warn(`Lyrics lookup failed: ${err.message}`);
        return answer('unavailable');
    }
}

// Tests only.
function _resetForTests() {
    inFlight.clear();
    pausedUntil = 0;
    writes = 0;
}

module.exports = {
    http,
    getLyrics,
    parseLrc,
    lookupCandidates,
    pickSearchResult,
    onlineEnabled,
    CREDIT,
    _resetForTests
};
