// Per-user service connections: storage, encryption and generic token refresh
// (ROADMAP Stage 3).
//
// One entry point, getSourceToken(db, userId, source), returns a valid access
// token for any OAuth source or throws a SourceError with a unified code:
//   SOURCE_NOT_CONNECTED   no row, or the stored token cannot be decrypted
//   SOURCE_TOKEN_EXPIRED   expired, and renewing with the refresh token failed
// Refresh happens server-side and single-flight per (source, user). The user is
// only sent back through the connect flow when the refresh itself fails.
const { SourceError } = require('./errors');
const { encrypt, decrypt } = require('./tokenCrypto');
const soundcloudTokens = require('../controllers/soundcloud/tokens');

const SOURCE_IDS = { youtube: 1, spotify: 2, soundcloud: 3, audius: 4, deezer: 5 }; // sources.id, see config/db.js

// Treat a token as expired a little early so a request never dies mid-flight.
const EXPIRY_SKEW_MS = 60 * 1000;

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Wrapped so tests can stub the network call.
const http = { fetch: (...args) => fetch(...args) };

const isFresh = (expiresAt) => !expiresAt || expiresAt > Date.now() + EXPIRY_SKEW_MS;

async function getConnection(db, userId, source) {
    const row = await db.get(
        `SELECT access_token, refresh_token, expires_at FROM user_connections WHERE user_id = ? AND source_id = ?`,
        [userId, SOURCE_IDS[source]]
    );
    if (!row) return null;
    return {
        accessToken: decrypt(row.access_token),
        refreshToken: decrypt(row.refresh_token),
        expiresAt: row.expires_at
    };
}

/** Upserts a connection. A missing refresh token keeps the stored one. */
async function storeConnection(db, userId, source, { accessToken, refreshToken, expiresAt }) {
    await db.run(
        `INSERT INTO user_connections (user_id, source_id, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, user_connections.refresh_token),
            expires_at = excluded.expires_at`,
        [userId, SOURCE_IDS[source], encrypt(accessToken), encrypt(refreshToken || null), expiresAt]
    );
}

async function clearRefreshToken(db, userId, source) {
    await db.run(
        `UPDATE user_connections SET refresh_token = NULL WHERE user_id = ? AND source_id = ?`,
        [userId, SOURCE_IDS[source]]
    );
}

// --- Google -----------------------------------------------------------------

async function refreshGoogle(refreshToken) {
    const body = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
    });
    const res = await http.fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
        const err = new Error(`Google token refresh failed (${res.status} ${json.error || ''})`.trim());
        err.status = res.status;
        err.oauthError = json.error;
        throw err;
    }
    return {
        accessToken: json.access_token,
        // Google normally omits refresh_token on refresh; storeConnection keeps the old one.
        refreshToken: json.refresh_token || null,
        expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000
    };
}

const inFlight = new Map(); // `${source}:${userId}` -> Promise<accessToken>

async function getYouTubeToken(db, userId) {
    const conn = await getConnection(db, userId, 'youtube');
    if (!conn || !conn.accessToken) throw new SourceError('SOURCE_NOT_CONNECTED', 'youtube');
    if (isFresh(conn.expiresAt)) return conn.accessToken;
    if (!conn.refreshToken) throw new SourceError('SOURCE_TOKEN_EXPIRED', 'youtube');

    const key = `youtube:${userId}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const pending = refreshGoogle(conn.refreshToken)
        .then(async (tokens) => {
            await storeConnection(db, userId, 'youtube', tokens);
            return tokens.accessToken;
        })
        .catch(async (err) => {
            // invalid_grant means the grant was revoked or expired: the refresh
            // token is dead, so drop it and make the user reconnect. A network
            // error or 5xx keeps it for the next attempt.
            if (err.oauthError === 'invalid_grant' || err.status === 400 || err.status === 401) {
                await clearRefreshToken(db, userId, 'youtube');
            }
            console.warn(`YouTube token refresh failed for user ${userId}: ${err.message}`);
            throw new SourceError('SOURCE_TOKEN_EXPIRED', 'youtube', { cause: err });
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, pending);
    return pending;
}

// --- SoundCloud (renewal lives in controllers/soundcloud/tokens.js) ----------

async function getSoundCloudToken(db, userId) {
    try {
        return await soundcloudTokens.getUserToken(db, userId);
    } catch (err) {
        if (err.code === 'SOUNDCLOUD_NOT_CONNECTED') throw new SourceError('SOURCE_NOT_CONNECTED', 'soundcloud', { cause: err });
        if (err.code === 'SOUNDCLOUD_TOKEN_EXPIRED') throw new SourceError('SOURCE_TOKEN_EXPIRED', 'soundcloud', { cause: err });
        throw err;
    }
}

const PROVIDERS = {
    youtube: getYouTubeToken,
    soundcloud: getSoundCloudToken
};

/** Returns a valid access token for `source`, refreshing it when needed. */
function getSourceToken(db, userId, source) {
    const provider = PROVIDERS[source];
    if (!provider) throw new Error(`Unknown source: ${source}`);
    return provider(db, userId);
}

/** Whether the server can renew this source's token without the user. */
const canRefresh = (source, hasRefreshToken) => Boolean(hasRefreshToken) && Object.prototype.hasOwnProperty.call(PROVIDERS, source);

// Tests only.
function _resetInFlight() { inFlight.clear(); }

module.exports = {
    SOURCE_IDS,
    http,
    getConnection,
    storeConnection,
    getSourceToken,
    canRefresh,
    _resetInFlight
};
