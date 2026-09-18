// Thin HTTP client for the SoundCloud public API.
//
// Sources of truth (do not invent endpoints or headers):
//   OpenAPI spec  https://developers.soundcloud.com/docs/api/explorer/api.json
//   API guide     https://developers.soundcloud.com/docs/api/guide
//
// Facts this module encodes:
//   - API base URL is https://api.soundcloud.com; the token endpoint lives on
//     https://secure.soundcloud.com/oauth/token.
//   - Auth is OAuth 2.1. The authorization-code flow requires PKCE (S256).
//   - Every API request carries `Authorization: OAuth <access_token>`.
//   - Access tokens live ~1 hour. Refresh tokens are single-use.
//   - The client_credentials grant only accepts HTTP Basic auth and is
//     rate-limited (50 per 12 h per app, 30 per 1 h per IP), so callers must
//     cache the token and renew it with the refresh_token grant.
//   - Collections paginate with linked_partitioning=true and a next_href.
//   - Track `access` is `playable`, `preview` or `blocked`.
//
// This file is deliberately free of database code: tokens.js owns persistence.

const crypto = require('crypto');

const API_BASE = 'https://api.soundcloud.com';
const AUTH_BASE = 'https://secure.soundcloud.com';
const AUTHORIZE_URL = `${AUTH_BASE}/authorize`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const SIGN_OUT_URL = `${AUTH_BASE}/sign-out`;

const SOURCE_NAME = 'soundcloud';
const DEFAULT_REDIRECT_URI = 'http://localhost:3000/auth/soundcloud/callback';

// Retry policy for 429 / 503: exponential back-off, capped, few attempts. The
// play-stream limit is a 24 h window, so hammering it would never help.
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

// Wrapped so tests can stub the network without touching globals everywhere.
const http = {
    fetch: (...args) => globalThis.fetch(...args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

class SoundCloudError extends Error {
    constructor(message, { status, code, body, retryAfterMs, resetTime } = {}) {
        super(message);
        this.name = 'SoundCloudError';
        this.status = status;
        this.code = code;
        this.body = body;
        this.retryAfterMs = retryAfterMs;
        this.resetTime = resetTime;
    }
}

// --- Configuration -----------------------------------------------------------

function getConfig() {
    return {
        clientId: process.env.SOUNDCLOUD_CLIENT_ID,
        clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET,
        redirectUri: process.env.SOUNDCLOUD_REDIRECT_URI || DEFAULT_REDIRECT_URI
    };
}

function isConfigured() {
    const { clientId, clientSecret } = getConfig();
    return Boolean(clientId && clientSecret);
}

function assertConfigured() {
    if (!isConfigured()) {
        throw new SoundCloudError('SoundCloud client credentials are not configured', {
            status: 503,
            code: 'SOUNDCLOUD_NOT_CONFIGURED'
        });
    }
}

// --- PKCE / authorization URL -------------------------------------------------

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// RFC 7636: verifier is 43-128 chars from the unreserved set; S256 challenge is
// the base64url-encoded SHA-256 of the verifier.
function generatePkce() {
    const verifier = base64url(crypto.randomBytes(64)); // 86 chars
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function generateState() {
    return crypto.randomBytes(24).toString('hex');
}

function buildAuthorizeUrl({ state, codeChallenge }) {
    assertConfigured();
    const { clientId, redirectUri } = getConfig();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
}

// --- Token endpoint -----------------------------------------------------------

function normalizeTokenResponse(body) {
    if (!body || typeof body.access_token !== 'string') {
        throw new SoundCloudError('Token response did not include an access_token', { status: 502, body });
    }
    const expiresInSec = Number(body.expires_in) || 3600;
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
        expiresAt: Date.now() + expiresInSec * 1000,
        scope: body.scope || null
    };
}

async function postToken(form, { basicAuth = false } = {}) {
    assertConfigured();
    const { clientId, clientSecret } = getConfig();

    const headers = {
        'Accept': 'application/json; charset=utf-8',
        'Content-Type': 'application/x-www-form-urlencoded'
    };
    const body = new URLSearchParams(form);

    if (basicAuth) {
        headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    } else {
        body.set('client_id', clientId);
        body.set('client_secret', clientSecret);
    }

    const res = await http.fetch(TOKEN_URL, { method: 'POST', headers, body: body.toString() });
    const json = await readJson(res);

    if (!res.ok) {
        throw new SoundCloudError(`Token request failed (${res.status})`, {
            status: res.status,
            code: (json && (json.error || json.code)) || 'TOKEN_REQUEST_FAILED',
            body: json
        });
    }
    return normalizeTokenResponse(json);
}

// Authorization code -> tokens. The verifier must be the one generated for
// this exact authorize URL; the redirect_uri must match it exactly.
function exchangeCode({ code, codeVerifier }) {
    const { redirectUri } = getConfig();
    return postToken({
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        code
    });
}

// Refresh tokens are single-use: the caller MUST persist the new refresh_token
// from the result before doing anything else, and must never retry with the
// old one.
function refreshAccessToken(refreshToken) {
    return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

// App-level token for public resources (search, streams, resolve). Only HTTP
// Basic auth is supported for this grant. Rate-limited: cache the result.
function fetchClientCredentialsToken() {
    return postToken({ grant_type: 'client_credentials' }, { basicAuth: true });
}

// Best-effort session invalidation; failures are not fatal for a disconnect.
async function signOut(accessToken) {
    const res = await http.fetch(SIGN_OUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken })
    });
    return res.ok;
}

// --- API requests -------------------------------------------------------------

async function readJson(res) {
    const text = await res.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text.slice(0, 500) };
    }
}

function parseRetryAfter(res) {
    const header = res.headers && res.headers.get && res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const at = Date.parse(header);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// The 429 body documents when the window resets (see Rate Limits page).
function extractResetTime(body) {
    const entry = body && Array.isArray(body.errors) && body.errors.find((e) => e && e.meta);
    return entry ? entry.meta.reset_time || null : null;
}

function backoffDelay(attempt, retryAfterMs) {
    if (retryAfterMs != null && retryAfterMs <= BACKOFF_CAP_MS) return retryAfterMs;
    const exp = BACKOFF_BASE_MS * 2 ** attempt;
    const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS);
    return Math.min(BACKOFF_CAP_MS, exp + jitter);
}

// Builds an absolute API URL. `pathOrUrl` may be a next_href (already absolute)
// or a path; absolute URLs must stay on the API host so a client-supplied
// cursor can never make us call an arbitrary server.
function buildUrl(pathOrUrl, query) {
    let url;
    if (/^https?:\/\//i.test(pathOrUrl)) {
        url = new URL(pathOrUrl);
        if (url.origin !== API_BASE) {
            throw new SoundCloudError('Refusing to follow a URL outside the SoundCloud API', { status: 400, code: 'BAD_CURSOR' });
        }
    } else {
        url = new URL(pathOrUrl, API_BASE);
    }
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null) continue;
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

/**
 * Performs one authenticated API call and parses JSON.
 * Retries 429 and 503 with exponential back-off (bounded), then surfaces a
 * SoundCloudError carrying status, reset time and the raw body.
 */
async function apiRequest(pathOrUrl, { token, query, method = 'GET', body, retries = MAX_RETRIES } = {}) {
    if (!token) throw new SoundCloudError('No SoundCloud access token available', { status: 401, code: 'NO_TOKEN' });

    const url = buildUrl(pathOrUrl, query);
    const headers = {
        'Accept': 'application/json; charset=utf-8',
        'Authorization': `OAuth ${token}`
    };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        init.body = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
        const res = await http.fetch(url, init);

        if ((res.status === 429 || res.status === 503) && attempt < retries) {
            await http.sleep(backoffDelay(attempt, parseRetryAfter(res)));
            continue;
        }

        if (res.status === 204) return null;
        const json = await readJson(res);

        if (!res.ok) {
            const resetTime = extractResetTime(json);
            const message = res.status === 429
                ? `SoundCloud rate limit reached${resetTime ? ` (resets ${resetTime})` : ''}`
                : `SoundCloud API ${method} ${url} failed with ${res.status}`;
            throw new SoundCloudError(message, {
                status: res.status,
                code: res.status === 429 ? 'RATE_LIMITED' : `HTTP_${res.status}`,
                body: json,
                retryAfterMs: parseRetryAfter(res),
                resetTime
            });
        }
        return json;
    }
}

/**
 * Fetches a paginated collection. Always requests linked_partitioning=true and
 * follows next_href until it is absent or `maxPages` is reached. Returns the
 * accumulated items plus the next cursor (a next_href) if more remain.
 */
async function fetchCollection(pathOrUrl, { token, query = {}, maxPages = 1 } = {}) {
    const items = [];
    let next = pathOrUrl;
    let nextQuery = { ...query, linked_partitioning: true };
    let nextHref = null;

    for (let page = 0; next && page < maxPages; page++) {
        const data = await apiRequest(next, { token, query: nextQuery });
        // Legacy (un-partitioned) responses are a bare array.
        const pageItems = Array.isArray(data) ? data : (data && Array.isArray(data.collection) ? data.collection : []);
        items.push(...pageItems);
        nextHref = !Array.isArray(data) && data && typeof data.next_href === 'string' ? data.next_href : null;
        next = nextHref;
        nextQuery = undefined; // next_href already carries every parameter
    }

    return { items, nextHref };
}

// --- Identifiers & normalisation ----------------------------------------------

// The spec addresses resources by URN (soundcloud:tracks:123). We expose the
// numeric part to the client and rebuild the URN for path parameters.
const NUMERIC_ID = /^\d{1,20}$/;

function idFromUrn(urn) {
    if (typeof urn !== 'string') return null;
    const last = urn.split(':').pop();
    return NUMERIC_ID.test(last) ? last : null;
}

function isValidId(id) {
    return typeof id === 'string' && NUMERIC_ID.test(id);
}

const toTrackUrn = (id) => `soundcloud:tracks:${id}`;
const toPlaylistUrn = (id) => `soundcloud:playlists:${id}`;

function resourceId(obj) {
    if (!obj) return null;
    if (obj.id !== undefined && obj.id !== null && NUMERIC_ID.test(String(obj.id))) return String(obj.id);
    return idFromUrn(obj.urn);
}

// artwork_url is the 100x100 "large" rendition; the CDN serves a 300x300 one
// under the same name. Fall back to the uploader's avatar when a track has none.
function pickArtwork(track) {
    const raw = track.artwork_url || (track.user && track.user.avatar_url) || null;
    return raw ? raw.replace('-large.', '-t300x300.') : null;
}

function normalizeTrack(track) {
    const id = resourceId(track);
    const access = track.access || (track.streamable === false ? 'blocked' : 'playable');
    const artist = track.metadata_artist || (track.user && track.user.username) || 'Unknown Artist';
    return {
        id,
        source: SOURCE_NAME,
        title: track.title || 'Untitled',
        channelTitle: artist,
        artist,
        thumbnail: pickArtwork(track),
        duration: Math.round((Number(track.duration) || 0) / 1000),
        access,
        preview: access === 'preview',
        playable: access !== 'blocked',
        permalinkUrl: track.permalink_url || null,
        uploaderUrl: (track.user && track.user.permalink_url) || null
    };
}

function normalizePlaylist(playlist) {
    return {
        id: resourceId(playlist),
        source: SOURCE_NAME,
        kind: 'playlist',
        title: playlist.title || 'Untitled',
        name: playlist.title || 'Untitled',
        thumbnail: playlist.artwork_url ? playlist.artwork_url.replace('-large.', '-t300x300.') : null,
        itemCount: Number(playlist.track_count) || (Array.isArray(playlist.tracks) ? playlist.tracks.length : 0),
        permalinkUrl: playlist.permalink_url || null,
        readOnly: true
    };
}

// GET /tracks/{urn}/streams returns { hls_aac_160_url, hls_mp3_128_url,
// preview_mp3_128_url }. Prefer a full-length stream; fall back to the preview
// snippet so Go+ tracks still play something. ffmpeg consumes HLS directly.
function pickStreamUrl(streams) {
    if (!streams || typeof streams !== 'object') return null;
    if (streams.hls_mp3_128_url) return { url: streams.hls_mp3_128_url, isPreview: false, format: 'hls_mp3_128' };
    if (streams.hls_aac_160_url) return { url: streams.hls_aac_160_url, isPreview: false, format: 'hls_aac_160' };
    if (streams.preview_mp3_128_url) return { url: streams.preview_mp3_128_url, isPreview: true, format: 'preview_mp3_128' };
    return null;
}

module.exports = {
    API_BASE,
    AUTH_BASE,
    AUTHORIZE_URL,
    TOKEN_URL,
    SOURCE_NAME,
    SoundCloudError,
    http,
    getConfig,
    isConfigured,
    assertConfigured,
    generatePkce,
    generateState,
    buildAuthorizeUrl,
    exchangeCode,
    refreshAccessToken,
    fetchClientCredentialsToken,
    signOut,
    apiRequest,
    fetchCollection,
    buildUrl,
    idFromUrn,
    isValidId,
    toTrackUrn,
    toPlaylistUrn,
    normalizeTrack,
    normalizePlaylist,
    pickStreamUrl
};
