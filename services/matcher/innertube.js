// YouTube Music search over InnerTube: the match engine's primary candidate source.
//
// InnerTube is the private JSON API behind music.youtube.com (the same endpoint
// yt-dlp's YouTube Music extractor talks to). It is undocumented and can change
// without notice, so expect maintenance; services/matcher/ytsearch.js is the
// fallback for that day. It is still worth it because of one field nothing
// else exposes: YouTube Music classifies every result itself as
//
//   MUSIC_VIDEO_TYPE_ATV   catalog audio track (the "<Artist> - Topic" upload)
//   MUSIC_VIDEO_TYPE_OMV   official music video, linked to the artist entity
//   MUSIC_VIDEO_TYPE_UGC   user upload: fan re-uploads, lyric channels, covers
//
// and ATV/OMV versus UGC *is* the product's "official sources only" rule, with
// no channel-name guessing. The songs filter answers in ~0.5 s with catalog
// releases only (the same label deliveries Spotify has); the videos filter adds
// official music videos plus UGC, which searchVideos drops before returning.
//
// Network access goes through `http.fetch` so tests can stub it.

const SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';

// The web client's identity. The server checks clientVersion loosely: a dated
// but well-formed version keeps working for a long time.
const CLIENT = Object.freeze({
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240925.01.00',
    hl: 'en',
    gl: 'US'
});

// YouTube Music's own search filter tokens: the opaque `params` the web client
// sends when a user picks the "Songs" or "Videos" chip. They are protobuf blobs
// captured from the site, not something we construct; keep them verbatim.
const SONGS_PARAMS = 'EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D';
const VIDEOS_PARAMS = 'EgWKAQIQAWoKEAoQAxAEEAkQBQ%3D%3D';
const FILTER_PARAMS = { songs: SONGS_PARAMS, videos: VIDEOS_PARAMS };

// A desktop browser UA: InnerTube answers the WEB_REMIX client with a reduced
// response (or a 403) when the agent is obviously not a browser.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const TIMEOUT_MS = 8000;
// A search response is ~200 KB. Anything near this cap is not a search result,
// and reading it would only tie up memory for a parse that will not help.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

// Only these three are documented by observation; anything else (for example
// MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC, or a missing field) maps to 'unknown'
// and is treated like UGC downstream, because a guess in the other direction
// would let a private upload through.
const VIDEO_TYPES = {
    MUSIC_VIDEO_TYPE_ATV: 'atv',
    MUSIC_VIDEO_TYPE_OMV: 'omv',
    MUSIC_VIDEO_TYPE_UGC: 'ugc'
};
const OFFICIAL_TYPES = new Set(['atv', 'omv']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DURATION_TEXT = /^(?:(\d+):)?(\d+):(\d{2})$/;
// "1.9B plays", "880M views", "9.4K views", "1,234 plays".
const COUNT_TEXT = /([\d.,]+)\s*([KMB])?\s*(plays|views)\b/i;
const SCALE = { K: 1e3, M: 1e6, B: 1e9 };

const ERROR_CODES = new Set(['UPSTREAM', 'RATE_LIMITED', 'UNAVAILABLE']);

// Wrapped so tests can stub the network without touching globals.
const http = {
    fetch: (...args) => globalThis.fetch(...args)
};

/**
 * One error type for every candidate source so the engine can treat them alike.
 *   UPSTREAM      the service answered, but not with a usable search result
 *   RATE_LIMITED  429 / 403: back off before asking again
 *   UNAVAILABLE   no answer at all: network failure, timeout, binary missing
 */
class MatchSourceError extends Error {
    constructor(code, message, { status = null, retryAfterMs = null, cause } = {}) {
        super(message || code, cause === undefined ? undefined : { cause });
        this.name = 'MatchSourceError';
        this.code = ERROR_CODES.has(code) ? code : 'UPSTREAM';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

// --- Parsing ------------------------------------------------------------------

/** "4:09" -> 249, "1:02:03" -> 3723; anything else -> null. */
function parseDurationText(text) {
    if (typeof text !== 'string') return null;
    const m = DURATION_TEXT.exec(text.trim());
    if (!m) return null;
    const [, hours, minutes, seconds] = m;
    return Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** "1.9B plays" -> 1900000000, "9.4K views" -> 9400; no count -> null. */
function parsePlays(text) {
    if (typeof text !== 'string') return null;
    const m = COUNT_TEXT.exec(text);
    if (!m) return null;
    const base = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) return null;
    const scale = SCALE[(m[2] || '').toUpperCase()] || 1;
    return Math.round(base * scale);
}

// Depth-first in document order, without recursion: a response is a few
// hundred KB of deeply nested renderers and a hostile one must not blow the
// stack. A found item is not descended into; items never nest.
function collectRenderers(root) {
    const found = [];
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
            continue;
        }
        const children = [];
        for (const [key, value] of Object.entries(node)) {
            if (key === 'musicResponsiveListItemRenderer' && value && typeof value === 'object') {
                found.push(value);
            } else {
                children.push(value);
            }
        }
        // Push siblings last-to-first so the first one is popped next.
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return found;
}

function runsOf(column) {
    const renderer = column && column.musicResponsiveListItemFlexColumnRenderer;
    const runs = renderer && renderer.text && renderer.text.runs;
    return Array.isArray(runs) ? runs.filter((run) => run && typeof run.text === 'string') : [];
}

const browseIdOf = (run) => {
    const endpoint = run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
    return endpoint && typeof endpoint.browseId === 'string' ? endpoint.browseId : null;
};

const isSeparator = (run) => run.text.trim() === '•';

function parseItem(item) {
    const columns = Array.isArray(item.flexColumns) ? item.flexColumns.map(runsOf) : [];
    const titleRuns = columns[0] || [];
    const title = titleRuns.map((run) => run.text).join('').trim();
    const watch = titleRuns
        .map((run) => run.navigationEndpoint && run.navigationEndpoint.watchEndpoint)
        .find(Boolean);
    const videoId = [watch && watch.videoId, item.playlistItemData && item.playlistItemData.videoId]
        .find((id) => typeof id === 'string' && VIDEO_ID.test(id)) || null;
    if (!videoId || !title) return null;

    const musicConfig = watch
        && watch.watchEndpointMusicSupportedConfigs
        && watch.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig;
    // Own-property lookup only: the type string comes from the response, and
    // a plain `VIDEO_TYPES[type]` would hand back a function for "constructor".
    const typeName = musicConfig && musicConfig.musicVideoType;
    const videoType = typeof typeName === 'string' && Object.hasOwn(VIDEO_TYPES, typeName) ? VIDEO_TYPES[typeName] : 'unknown';

    // Column 1 reads "Artist, Artist & Artist • Album • 4:09" (songs) or
    // "Artist • 880M views • 4:09" (videos). Artists are the linked runs before
    // the first bullet; the plain-text runs between them are just punctuation.
    const metaRuns = columns[1] || [];
    const artists = [];
    for (const run of metaRuns) {
        if (isSeparator(run)) break;
        const browseId = browseIdOf(run);
        if (browseId && browseId.startsWith('UC') && run.text.trim()) artists.push(run.text.trim());
    }
    const albumRun = metaRuns.find((run) => (browseIdOf(run) || '').startsWith('MPREb'));
    const album = albumRun ? albumRun.text.trim() : null;

    const detailRuns = columns.slice(1).flat();
    const durationRun = [...detailRuns].reverse().find((run) => DURATION_TEXT.test(run.text.trim()));
    const playsRun = detailRuns.find((run) => COUNT_TEXT.test(run.text));

    return {
        videoId,
        title,
        artists,
        album,
        durationSec: durationRun ? parseDurationText(durationRun.text) : null,
        plays: (playsRun && parsePlays(playsRun.text)) || 0,
        videoType,
        origin: 'ytmusic'
    };
}

/**
 * Extracts every song/video item from a search response. Items without a
 * video id or a title are skipped; a video listed twice (top result and shelf)
 * is returned once, in first-seen order.
 */
function parseResults(json) {
    const seen = new Set();
    const candidates = [];
    for (const item of collectRenderers(json)) {
        const candidate = parseItem(item);
        if (!candidate || seen.has(candidate.videoId)) continue;
        seen.add(candidate.videoId);
        candidates.push(candidate);
    }
    return candidates;
}

// --- Network ------------------------------------------------------------------

function parseRetryAfter(res) {
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
    const at = Date.parse(header);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function contentLength(res) {
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    const n = Number(header);
    return header !== null && header !== undefined && Number.isFinite(n) ? n : null;
}

// Every rejection from fetch/text() is "no usable answer". The abort reason is
// preferred because it already says *why* (timeout vs caller cancel).
function asUnavailable(err, signal) {
    if (err instanceof MatchSourceError) return err;
    if (signal.aborted && signal.reason instanceof MatchSourceError) return signal.reason;
    const why = signal.aborted ? 'the request was aborted' : (err && err.message) || String(err);
    return new MatchSourceError('UNAVAILABLE', `YouTube Music is unreachable: ${why}`, { cause: err });
}

// Reads the body as text without ever holding more than MAX_BODY_BYTES.
// InnerTube answers chunked (no Content-Length), so the cap is enforced on the
// running total while streaming and the connection is aborted the moment it is
// crossed. Stubs without a body stream fall back to text().
async function readBody(res, controller, status) {
    const tooLarge = (size) => new MatchSourceError('UPSTREAM', `YouTube Music response too large (${size} bytes)`, { status });
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
        let text;
        try {
            text = await res.text();
        } catch (err) {
            throw asUnavailable(err, controller.signal);
        }
        const size = Buffer.byteLength(text);
        if (size > MAX_BODY_BYTES) throw tooLarge(size);
        return text;
    }

    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                const err = tooLarge(total);
                controller.abort(err);
                reader.cancel().catch(() => {});
                throw err;
            }
            chunks.push(chunk);
        }
    } catch (err) {
        throw asUnavailable(err, controller.signal);
    }
    return Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Runs one InnerTube search and returns parsed candidates.
 * @param {string} query
 * @param {{ filter?: 'songs'|'videos', signal?: AbortSignal }} [options]
 */
async function search(query, { filter = 'songs', signal } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new TypeError('InnerTube search needs a non-empty query');
    const params = FILTER_PARAMS[filter];
    if (!params) throw new TypeError(`Unknown InnerTube search filter: ${filter}`);

    // One controller carries both our timeout and the caller's signal, so a
    // single `signal` reaches fetch and the body read.
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new MatchSourceError('UNAVAILABLE', `YouTube Music search timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal) {
        if (signal.aborted) forwardAbort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
        let res;
        try {
            res = await http.fetch(SEARCH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://music.youtube.com',
                    'Referer': 'https://music.youtube.com/',
                    'User-Agent': USER_AGENT
                },
                body: JSON.stringify({ context: { client: CLIENT }, query, params }),
                signal: controller.signal
            });
        } catch (err) {
            throw asUnavailable(err, controller.signal);
        }

        const status = typeof res.status === 'number' ? res.status : (res.ok ? 200 : 0);
        if (status < 200 || status >= 300) {
            const retryAfterMs = parseRetryAfter(res);
            // 403 is how InnerTube says "too many anonymous requests from here".
            const limited = status === 429 || status === 403;
            throw new MatchSourceError(
                limited ? 'RATE_LIMITED' : 'UPSTREAM',
                `YouTube Music search failed with HTTP ${status}`,
                { status, retryAfterMs }
            );
        }

        const declared = contentLength(res);
        if (declared !== null && declared > MAX_BODY_BYTES) {
            throw new MatchSourceError('UPSTREAM', `YouTube Music response too large (${declared} bytes)`, { status });
        }

        const text = await readBody(res, controller, status);

        let json;
        try {
            json = JSON.parse(text);
        } catch (err) {
            throw new MatchSourceError('UPSTREAM', 'YouTube Music response was not JSON', { status, cause: err });
        }
        return parseResults(json);
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forwardAbort);
    }
}

/** Catalog songs: every item is an ATV upload by construction. */
function searchSongs(query, { signal } = {}) {
    return search(query, { filter: 'songs', signal });
}

/**
 * Official music videos. The videos filter also returns UGC (fan uploads,
 * lyric videos, covers); those are dropped here so callers only ever see
 * candidates that may be acceptable.
 */
async function searchVideos(query, { signal } = {}) {
    const candidates = await search(query, { filter: 'videos', signal });
    return candidates.filter((c) => OFFICIAL_TYPES.has(c.videoType));
}

module.exports = {
    http,
    search,
    searchSongs,
    searchVideos,
    parseResults,
    parseDurationText,
    parsePlays,
    MatchSourceError,
    SONGS_PARAMS,
    VIDEOS_PARAMS
};
