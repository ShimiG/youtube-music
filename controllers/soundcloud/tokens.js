// Token persistence and renewal for SoundCloud.
//
// Two kinds of token live here:
//   1. The app token (client_credentials grant) used for public resources:
//      search, stream resolution, track metadata. It is cached in the
//      `app_tokens` table so a restart does not spend another exchange, and
//      it is renewed with the refresh_token grant instead of a fresh
//      client_credentials exchange (both are rate-limited per app and per IP).
//   2. Per-user tokens (authorization_code grant) in `user_connections`,
//      needed for /me/* (playlists, likes).
//
// Refresh tokens are single-use, so every refresh is single-flight (one
// in-progress promise per key) and the new refresh_token is written to the
// database before the caller gets the access token. A failed refresh is never
// retried with the same refresh token.

const client = require('./client');

const SOURCE_SOUNDCLOUD = 3; // sources.id, see config/db.js
const PROVIDER_KEY = 'soundcloud';

// Treat a token as expired a little early so a request never dies mid-flight.
const EXPIRY_SKEW_MS = 60 * 1000;

let appTokenMemo = null;      // { accessToken, refreshToken, expiresAt }
let appTokenInFlight = null;  // Promise while a fetch/refresh is running
const userRefreshInFlight = new Map(); // userId -> Promise<accessToken>

const isFresh = (expiresAt) => typeof expiresAt === 'number' && expiresAt > Date.now() + EXPIRY_SKEW_MS;

async function persistAppToken(db, tokens) {
    await db.run(
        `INSERT INTO app_tokens (provider, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at`,
        [PROVIDER_KEY, tokens.accessToken, tokens.refreshToken, tokens.expiresAt]
    );
    appTokenMemo = tokens;
}

async function acquireAppToken(db) {
    const row = await db.get(
        `SELECT access_token, refresh_token, expires_at FROM app_tokens WHERE provider = ?`,
        [PROVIDER_KEY]
    );

    if (row && row.access_token && isFresh(row.expires_at)) {
        appTokenMemo = { accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.expires_at };
        return appTokenMemo.accessToken;
    }

    // Prefer renewing over a brand-new client_credentials exchange. One attempt
    // only: a refresh token that fails is spent, so fall through instead of looping.
    if (row && row.refresh_token) {
        try {
            const refreshed = await client.refreshAccessToken(row.refresh_token);
            await persistAppToken(db, refreshed);
            return refreshed.accessToken;
        } catch (err) {
            console.warn('SoundCloud app token refresh failed, requesting a new client_credentials token:', err.message);
        }
    }

    const fresh = await client.fetchClientCredentialsToken();
    await persistAppToken(db, fresh);
    return fresh.accessToken;
}

/** Returns a valid app-level access token, fetching or renewing it if needed. */
async function getAppToken(db) {
    if (appTokenMemo && isFresh(appTokenMemo.expiresAt)) return appTokenMemo.accessToken;
    if (appTokenInFlight) return appTokenInFlight;

    appTokenInFlight = acquireAppToken(db).finally(() => { appTokenInFlight = null; });
    return appTokenInFlight;
}

/** Stores the tokens obtained when a user connects their SoundCloud account. */
async function storeUserTokens(db, userId, tokens) {
    await db.run(
        `INSERT INTO user_connections (user_id, source_id, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, user_connections.refresh_token),
            expires_at = excluded.expires_at`,
        [userId, SOURCE_SOUNDCLOUD, tokens.accessToken, tokens.refreshToken, tokens.expiresAt]
    );
}

async function getUserConnection(db, userId) {
    return db.get(
        `SELECT access_token, refresh_token, expires_at FROM user_connections WHERE user_id = ? AND source_id = ?`,
        [userId, SOURCE_SOUNDCLOUD]
    );
}

async function refreshUserConnection(db, userId, refreshToken) {
    const refreshed = await client.refreshAccessToken(refreshToken);
    await storeUserTokens(db, userId, refreshed);
    return refreshed.accessToken;
}

/**
 * Returns a valid user access token, refreshing it when it is expired or about
 * to expire. Throws a SoundCloudError with code SOUNDCLOUD_NOT_CONNECTED or
 * SOUNDCLOUD_TOKEN_EXPIRED so callers can map it to a 401 with the right hint.
 */
async function getUserToken(db, userId) {
    const row = await getUserConnection(db, userId);
    if (!row || !row.access_token) {
        throw new client.SoundCloudError('No SoundCloud account connected', { status: 401, code: 'SOUNDCLOUD_NOT_CONNECTED' });
    }
    if (isFresh(row.expires_at)) return row.access_token;

    if (!row.refresh_token) {
        throw new client.SoundCloudError('SoundCloud session expired', { status: 401, code: 'SOUNDCLOUD_TOKEN_EXPIRED' });
    }

    if (userRefreshInFlight.has(userId)) return userRefreshInFlight.get(userId);

    const pending = refreshUserConnection(db, userId, row.refresh_token)
        .catch((err) => {
            // The old refresh token is now spent either way. Clear it so the next
            // call reports "expired" instead of retrying a dead token forever.
            return db.run(
                `UPDATE user_connections SET refresh_token = NULL WHERE user_id = ? AND source_id = ?`,
                [userId, SOURCE_SOUNDCLOUD]
            ).then(() => {
                throw new client.SoundCloudError(`SoundCloud session expired (${err.message})`, {
                    status: 401,
                    code: 'SOUNDCLOUD_TOKEN_EXPIRED'
                });
            });
        })
        .finally(() => userRefreshInFlight.delete(userId));

    userRefreshInFlight.set(userId, pending);
    return pending;
}

/** Removes the stored connection and best-effort invalidates the session. */
async function disconnectUser(db, userId) {
    const row = await getUserConnection(db, userId);
    await db.run(`DELETE FROM user_connections WHERE user_id = ? AND source_id = ?`, [userId, SOURCE_SOUNDCLOUD]);
    if (row && row.access_token) {
        try { await client.signOut(row.access_token); } catch { /* already gone or network issue */ }
    }
}

// Tests only.
function _resetCaches() {
    appTokenMemo = null;
    appTokenInFlight = null;
    userRefreshInFlight.clear();
}

module.exports = {
    SOURCE_SOUNDCLOUD,
    EXPIRY_SKEW_MS,
    getAppToken,
    getUserToken,
    storeUserTokens,
    getUserConnection,
    disconnectUser,
    _resetCaches
};
