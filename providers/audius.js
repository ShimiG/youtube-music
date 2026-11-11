// Audius provider (ROADMAP Stage 6): an open music catalog with full-length
// free tracks. Search and playback need no account or API key.
//
// Built against Audius's OpenAPI spec (AudiusProject/audius-protocol,
// packages/docs/docs/public/openapi.yaml):
//   GET /v1/tracks/search?query=&offset=&limit=   -> { data: Track[] }
//   GET /v1/tracks/{id}                           -> { data: Track }
//   GET /v1/tracks/{id}/stream?no_redirect=true   -> { data: "<mp3 url>" }
//                              &preview=true      (30 s preview of a gated track)
// Track fields used: id, title, duration (seconds), user.name, artwork
// ("150x150" / "480x480" / "1000x1000"), permalink, isrc, is_streamable,
// is_stream_gated, preview_cid, is_delete, is_available.
//
// Read-only use needs no credentials; AUDIUS_API_KEY (optional, free tier at
// api.audius.co/plans) is sent as `api_key` on stream requests, the one place
// the spec documents it, for tracks that only allow specific apps.
//
// The library (favorites, playlists) needs a user: a public handle or "Log in
// with Audius". Not in this first version; capabilities say so.
const { SourceError } = require('./errors');
const { makeTrack, page } = require('./normalize');

const SOURCE = 'audius';
const LABEL = 'Audius';
const SOURCE_ID = 4; // sources.id in config/db.js
const SEARCH_SIZE = 30;
const MAX_OFFSET = 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

// Audius ids are short hashids ("D7KyD"); strict so they are safe in URLs and
// as cache keys (audius_<id>).
const TRACK_ID = /^[A-Za-z0-9]{1,32}$/;
const isValidId = (id) => typeof id === 'string' && TRACK_ID.test(id);

const apiBase = () => (process.env.AUDIUS_API_BASE || 'https://api.audius.co/v1').replace(/\/+$/, '');

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
    if (res.status === 404) throw new SourceError('NOT_FOUND', `Not available on ${LABEL}.`, { source: SOURCE });
    if (res.status === 429) throw new SourceError('RATE_LIMITED', `${LABEL} rate limit reached. Try again later.`, { source: SOURCE });
    if (!res.ok) throw new SourceError('UPSTREAM', `${LABEL} request failed (${res.status}).`, { source: SOURCE });
    try {
        return await res.json();
    } catch (err) {
        throw new SourceError('UPSTREAM', `${LABEL} sent an unreadable response.`, { source: SOURCE, cause: err });
    }
}

// --- Normalisation --------------------------------------------------------------

const httpsOrNull = (value) => (typeof value === 'string' && /^https:\/\//.test(value) ? value : null);

function artworkOf(track) {
    const art = track && track.artwork;
    if (!art || typeof art !== 'object') return null;
    return httpsOrNull(art['480x480']) || httpsOrNull(art['150x150']) || httpsOrNull(art['1000x1000']);
}

/**
 * Whether and how a track can be played:
 *   full     the whole track streams
 *   preview  stream-gated (premium / collectible) but has a preview
 *   blocked  deleted, unavailable, not streamable, or gated without a preview
 */
function accessOf(track) {
    if (!track || track.is_delete || track.is_available === false || track.is_streamable === false) return 'blocked';
    if (track.is_stream_gated) return track.preview_cid ? 'preview' : 'blocked';
    return 'full';
}

function toTrack(raw) {
    const access = accessOf(raw);
    const permalink = typeof raw.permalink === 'string' && raw.permalink.startsWith('/') ? raw.permalink : null;
    return makeTrack({
        source: SOURCE,
        id: raw.id,
        title: raw.title,
        artist: raw.user && raw.user.name,
        durationSec: raw.duration,
        thumbnail: artworkOf(raw),
        isrc: raw.isrc,
        preview: access === 'preview',
        playable: access !== 'blocked',
        permalinkUrl: permalink ? `https://audius.co${permalink}` : null
    });
}

// --- Search -----------------------------------------------------------------------

// Audius pages by offset; the cursor is that offset as a string.
function parseOffset(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    const n = Number(cursor);
    if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) {
        throw new SourceError('BAD_CURSOR', 'Invalid cursor.', { source: SOURCE });
    }
    return n;
}

async function search(_ctx, query, { cursor } = {}) {
    const offset = parseOffset(cursor);
    const body = await apiGet('/tracks/search', { query, offset, limit: SEARCH_SIZE });
    const raw = Array.isArray(body && body.data) ? body.data : [];
    const items = raw.filter((t) => t && isValidId(String(t.id))).map(toTrack);
    // A full page means there may be more.
    const next = raw.length >= SEARCH_SIZE && offset + SEARCH_SIZE <= MAX_OFFSET ? String(offset + SEARCH_SIZE) : null;
    return page(items, next);
}

// --- Playback helpers (used by controllers/audiusController.js) -------------------

async function getTrack(id) {
    if (!isValidId(id)) throw new SourceError('NOT_FOUND', 'Invalid track id.', { source: SOURCE });
    const body = await apiGet(`/tracks/${encodeURIComponent(id)}`);
    if (!body || !body.data) throw new SourceError('NOT_FOUND', `Not available on ${LABEL}.`, { source: SOURCE });
    return body.data;
}

/**
 * Resolves the MP3 URL to stream for a track: the full track, or its preview
 * for a gated track. Resolves with { url, isPreview, durationSec }.
 */
async function resolveStream(id) {
    const track = await getTrack(id);
    const access = accessOf(track);
    if (access === 'blocked') throw new SourceError('NOT_FOUND', 'This track cannot be streamed.', { source: SOURCE });
    const isPreview = access === 'preview';
    const body = await apiGet(`/tracks/${encodeURIComponent(id)}/stream`, {
        no_redirect: 'true',
        preview: isPreview ? 'true' : undefined,
        api_key: process.env.AUDIUS_API_KEY || undefined
    });
    const url = httpsOrNull(body && body.data);
    if (!url) throw new SourceError('UPSTREAM', `${LABEL} returned no stream URL.`, { source: SOURCE });
    return { url, isPreview, durationSec: Number.isFinite(track.duration) ? track.duration : null };
}

module.exports = {
    name: SOURCE,
    label: LABEL,
    sourceId: SOURCE_ID,
    // No account needed for search and playback.
    connect: { kind: 'none', required: false },
    capabilities: { search: true, playlists: false, liked: false, like: false, stream: true },
    searchRequiresToken: false,
    isAvailable: () => true,
    search,
    getTrack,
    resolveStream,
    toTrack,
    accessOf,
    isValidId,
    http
};
