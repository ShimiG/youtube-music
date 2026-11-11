// Deezer provider (ROADMAP Stage 6, issue #38): Deezer's public catalog for
// search, no account. Deezer no longer registers new apps for user login, and
// its full-track player is DRM-protected, so playback is:
//   1. the full track from YouTube, matched on play by the match engine
//      (services/matcher), using Deezer's ISRC for an exact recording match;
//   2. otherwise Deezer's own 30-second preview.
// See controllers/deezerController.js.
//
// Public API, no key (shapes as recorded by the deezer-python test suite):
//   GET https://api.deezer.com/search?q=&index=&limit=  -> { data: Track[], total, next }
//   GET https://api.deezer.com/track/{id}                -> Track (+ isrc, contributors)
// Track fields used: id (number), title, duration (s), readable, preview
// (30 s MP3 URL), link, isrc, artist.name, album.title, album.cover_medium.
// Errors arrive as HTTP 200 with { error: { type, message, code } };
// code 4 is the rate limit ("Quota"), 800 means no data.
const { SourceError } = require('./errors');
const { makeTrack, page } = require('./normalize');

const SOURCE = 'deezer';
const LABEL = 'Deezer';
const SOURCE_ID = 5; // sources.id in config/db.js
const SEARCH_SIZE = 30;
const MAX_INDEX = 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const PREVIEW_SECONDS = 30;

const TRACK_ID = /^[0-9]{1,20}$/;
const isValidId = (id) => typeof id === 'string' && TRACK_ID.test(id);

const apiBase = () => (process.env.DEEZER_API_BASE || 'https://api.deezer.com').replace(/\/+$/, '');

// Wrapped so tests can stub the network.
const http = { fetch: (...args) => fetch(...args) };

async function apiGet(path, query = {}) {
    const url = new URL(`${apiBase()}${path}`);
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    let res;
    try {
        res = await http.fetch(url.toString(), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (err) {
        throw new SourceError('UPSTREAM', `${LABEL} could not be reached.`, { source: SOURCE, cause: err });
    }
    if (res.status === 429) throw new SourceError('RATE_LIMITED', `${LABEL} rate limit reached. Try again later.`, { source: SOURCE });
    if (!res.ok) throw new SourceError('UPSTREAM', `${LABEL} request failed (${res.status}).`, { source: SOURCE });
    let body;
    try {
        body = await res.json();
    } catch (err) {
        throw new SourceError('UPSTREAM', `${LABEL} sent an unreadable response.`, { source: SOURCE, cause: err });
    }
    if (body && body.error) {
        const code = Number(body.error.code);
        if (code === 4) throw new SourceError('RATE_LIMITED', `${LABEL} rate limit reached. Try again later.`, { source: SOURCE });
        if (code === 800) throw new SourceError('NOT_FOUND', `Not available on ${LABEL}.`, { source: SOURCE });
        throw new SourceError('UPSTREAM', `${LABEL} request failed (${body.error.type || code}).`, { source: SOURCE });
    }
    return body;
}

// --- Normalisation --------------------------------------------------------------

const httpsOrNull = (value) => (typeof value === 'string' && /^https:\/\//.test(value) ? value : null);
const deezerLinkOrNull = (value) => (typeof value === 'string' && /^https:\/\/www\.deezer\.com\//.test(value) ? value : null);

function toTrack(raw) {
    const album = raw.album || {};
    return makeTrack({
        source: SOURCE,
        id: raw.id,
        title: raw.title,
        artist: raw.artist && raw.artist.name,
        album: album.title,
        // The catalog length. What actually plays (full match or 30 s preview)
        // is only known when it starts, so the player asks /duration.
        durationSec: raw.duration,
        verifyDuration: true,
        thumbnail: httpsOrNull(album.cover_medium) || httpsOrNull(album.cover_small),
        isrc: raw.isrc,
        playable: raw.readable !== false,
        permalinkUrl: deezerLinkOrNull(raw.link)
    });
}

// --- Search -----------------------------------------------------------------------

// Deezer pages by `index`; the cursor is that index as a string.
function parseIndex(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    const n = Number(cursor);
    if (!Number.isInteger(n) || n < 0 || n > MAX_INDEX) {
        throw new SourceError('BAD_CURSOR', 'Invalid cursor.', { source: SOURCE });
    }
    return n;
}

async function search(_ctx, query, { cursor } = {}) {
    const index = parseIndex(cursor);
    const body = await apiGet('/search', { q: query, index, limit: SEARCH_SIZE });
    const raw = Array.isArray(body && body.data) ? body.data : [];
    const items = raw.filter((t) => t && isValidId(String(t.id))).map(toTrack);
    const nextIndex = index + raw.length;
    const hasMore = Boolean(body && body.next) && raw.length > 0 && nextIndex <= MAX_INDEX;
    return page(items, hasMore ? String(nextIndex) : null);
}

// --- Track details for playback (controllers/deezerController.js) -----------------

// /stream and /duration both need the track, usually at the same moment;
// remember it briefly so one play is one Deezer request. Preview URLs are
// signed and expire, so the memo is short.
const TRACK_MEMO_MS = 5 * 60 * 1000;
const TRACK_MEMO_MAX = 300;
const trackMemo = new Map(); // id -> { at, promise }

function getTrack(id) {
    if (!isValidId(id)) return Promise.reject(new SourceError('NOT_FOUND', 'Invalid track id.', { source: SOURCE }));
    const hit = trackMemo.get(id);
    if (hit && Date.now() - hit.at < TRACK_MEMO_MS) return hit.promise;
    const promise = apiGet(`/track/${id}`).then((raw) => {
        if (!raw || String(raw.id) !== id) throw new SourceError('NOT_FOUND', `Not available on ${LABEL}.`, { source: SOURCE });
        return raw;
    });
    if (trackMemo.size >= TRACK_MEMO_MAX) trackMemo.delete(trackMemo.keys().next().value);
    trackMemo.set(id, { at: Date.now(), promise });
    promise.catch(() => trackMemo.delete(id)); // never remember a failure
    return promise;
}

/** The fields the match engine scores on, from a full Deezer track. */
function matchInput(raw) {
    const contributors = Array.isArray(raw.contributors) ? raw.contributors.map((c) => c && c.name).filter(Boolean) : [];
    return {
        source: SOURCE,
        id: String(raw.id),
        title: raw.title || '',
        artist: (raw.artist && raw.artist.name) || contributors[0] || null,
        artists: contributors.length ? contributors : undefined,
        album: (raw.album && raw.album.title) || null,
        durationSec: Number.isFinite(raw.duration) ? raw.duration : null,
        isrc: raw.isrc || null
    };
}

const previewUrlOf = (raw) => (raw && raw.readable !== false ? httpsOrNull(raw.preview) : null);

function _resetForTests() { trackMemo.clear(); }

module.exports = {
    name: SOURCE,
    label: LABEL,
    sourceId: SOURCE_ID,
    connect: { kind: 'none', required: false },
    capabilities: { search: true, playlists: false, liked: false, like: false, stream: true },
    searchRequiresToken: false,
    isAvailable: () => true,
    search,
    getTrack,
    matchInput,
    previewUrlOf,
    toTrack,
    isValidId,
    PREVIEW_SECONDS,
    http,
    _resetForTests
};
