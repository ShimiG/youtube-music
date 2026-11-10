// Media URLs for the player. /stream and /duration require a short-lived
// media token in the URL (`t`), because an <audio> element cannot send our
// login in a header (see services/mediaToken.js on the server). The token is
// fetched with the login, kept in memory only, and renewed before it expires.
import { API_BASE, apiFetch } from './api';

// Renew this long before expiry, so a URL handed to <audio> stays valid.
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

let cached = null;   // { token, expiresAt, forAuth }
let inFlight = null; // Promise while a fetch is running

const currentAuth = () => localStorage.getItem('authToken');

function freshToken() {
    if (!cached) return null;
    // A different login (or a logout) invalidates the cached token.
    if (cached.forAuth !== currentAuth()) { cached = null; return null; }
    return cached.expiresAt - Date.now() > REFRESH_MARGIN_MS ? cached.token : null;
}

/** Resolves with a valid media token, fetching or renewing it when needed. */
export async function getMediaToken() {
    const ready = freshToken();
    if (ready) return ready;
    const forAuth = currentAuth();
    if (!forAuth) throw new Error('Not logged in');
    if (!inFlight) {
        inFlight = apiFetch('/api/media/token')
            .then(data => {
                cached = { token: data.token, expiresAt: data.expiresAt, forAuth };
                return data.token;
            })
            .finally(() => { inFlight = null; });
    }
    return inFlight;
}

/** Fetches the token ahead of time (after login, and periodically). */
export function warmMediaToken() {
    if (!currentAuth()) return;
    getMediaToken().catch(() => { /* retried on the next play or tick */ });
}

function build(path, params, token) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null) query.set(key, String(value));
    }
    query.set('t', token);
    return `${API_BASE}${path}?${query}`;
}

/**
 * The media URL right now, or null when no fresh token is in memory. Lets the
 * player set <audio>.src and call play() synchronously inside the click
 * handler; webviews (WKWebView) can refuse play() after an await.
 */
export function mediaUrlSync(path, params) {
    const token = freshToken();
    return token ? build(path, params, token) : null;
}

/** The media URL, waiting for a token if needed. */
export async function mediaUrl(path, params) {
    return build(path, params, await getMediaToken());
}
