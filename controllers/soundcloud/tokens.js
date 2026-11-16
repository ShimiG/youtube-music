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
const { encrypt, decrypt } = require('../../services/tokenCrypto');
// Where the credentials are when this computer has none of its own: the cloud
// service keeps them and hands out tokens (services/cloud/soundcloud.js).
const cloudSoundcloud = require('../../services/cloud/soundcloud');
const { CloudError } = require('../../services/cloud/client');

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
        [PROVIDER_KEY, encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt]
    );
    appTokenMemo = tokens;
}

async function acquireAppToken(db) {
    const stored = await db.get(
        `SELECT access_token, refresh_token, expires_at FROM app_tokens WHERE provider = ?`,
        [PROVIDER_KEY]
    );
    const row = stored && {
        access_token: decrypt(stored.access_token),
        refresh_token: decrypt(stored.refresh_token),
        expires_at: stored.expires_at
    };

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

// The cloud is unreachable (or SoundCloud behind it): not a reason to send
// anyone through the connect flow again.
function cloudUnavailable(err) {
    return new client.SoundCloudError(`SoundCloud could not be reached through the cloud account (${err.message})`, { status: 503, code: 'SOUNDCLOUD_UNAVAILABLE' });
}

/**
 * Returns a valid app-level access token, fetching or renewing it if needed.
 * From the cloud service when it has SoundCloud's credentials; with this
 * computer's own credentials when it has some and the cloud does not.
 */
async function getAppToken(db) {
    if (cloudSoundcloud.available()) {
        let token = null;
        try {
            token = await cloudSoundcloud.appToken(db);
        } catch (err) {
            if (!(err instanceof CloudError) || !client.isConfigured()) throw err instanceof CloudError ? cloudUnavailable(err) : err;
        }
        if (token) return token;
    }
    if (appTokenMemo && isFresh(appTokenMemo.expiresAt)) return appTokenMemo.accessToken;
    if (appTokenInFlight) return appTokenInFlight;

    appTokenInFlight = acquireAppToken(db).finally(() => { appTokenInFlight = null; });
    return appTokenInFlight;
}

/** Drops the app-level token: it belongs to the app credentials it was issued for. */
async function forgetAppToken(db) {
    appTokenMemo = null;
    appTokenInFlight = null;
    await db.run(`DELETE FROM app_tokens WHERE provider = ?`, [PROVIDER_KEY]);
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
        [userId, SOURCE_SOUNDCLOUD, encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt]
    );
}

// Tokens are encrypted at rest (services/tokenCrypto.js); callers get plaintext.
async function getUserConnection(db, userId) {
    const row = await db.get(
        `SELECT access_token, refresh_token, expires_at FROM user_connections WHERE user_id = ? AND source_id = ?`,
        [userId, SOURCE_SOUNDCLOUD]
    );
    if (!row) return row;
    return {
        access_token: decrypt(row.access_token),
        refresh_token: decrypt(row.refresh_token),
        expires_at: row.expires_at
    };
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
    if (!row || !row.access_token) return fromCloudAccount(db, userId, null);
    if (isFresh(row.expires_at)) return row.access_token;

    // No refresh token here: the login is kept with the cloud account, which
    // renews it and hands out the next short-lived token.
    if (!row.refresh_token) return fromCloudAccount(db, userId, row);

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

// The account's SoundCloud login as the cloud account holds it. What comes
// back is stored here without a refresh token: the cloud keeps that.
const cloudInFlight = new Map(); // userId -> Promise<accessToken>
function fromCloudAccount(db, userId, row) {
    if (cloudInFlight.has(userId)) return cloudInFlight.get(userId);
    const none = () => new client.SoundCloudError(
        row ? 'SoundCloud session expired' : 'No SoundCloud account connected',
        { status: 401, code: row ? 'SOUNDCLOUD_TOKEN_EXPIRED' : 'SOUNDCLOUD_NOT_CONNECTED' }
    );
    const pending = (async () => {
        if (!(await cloudSoundcloud.connected(db, userId))) throw none();
        let token;
        try {
            token = await cloudSoundcloud.accessToken(db, userId);
        } catch (err) {
            if (err instanceof CloudError) throw cloudUnavailable(err);
            throw err;
        }
        if (!token) {
            // Disconnected on another computer: the token kept here is of no use.
            await db.run(
                `DELETE FROM user_connections WHERE user_id = ? AND source_id = ? AND refresh_token IS NULL`,
                [userId, SOURCE_SOUNDCLOUD]
            );
            throw new client.SoundCloudError('No SoundCloud account connected', { status: 401, code: 'SOUNDCLOUD_NOT_CONNECTED' });
        }
        await storeUserTokens(db, userId, { accessToken: token.accessToken, refreshToken: null, expiresAt: token.expiresAt });
        return token.accessToken;
    })().finally(() => cloudInFlight.delete(userId));
    cloudInFlight.set(userId, pending);
    return pending;
}

/**
 * Removes the stored connection and best-effort invalidates the session.
 * A login kept with the cloud account is disconnected there, for every
 * computer; that has to work, or the account would still be connected.
 */
async function disconnectUser(db, userId) {
    if (await cloudSoundcloud.connected(db, userId)) {
        try {
            await cloudSoundcloud.disconnect(db, userId);
        } catch (err) {
            if (err instanceof CloudError) throw cloudUnavailable(err);
            throw err;
        }
        await db.run(`DELETE FROM user_connections WHERE user_id = ? AND source_id = ?`, [userId, SOURCE_SOUNDCLOUD]);
        return;
    }
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
    cloudInFlight.clear();
}

module.exports = {
    SOURCE_SOUNDCLOUD,
    EXPIRY_SKEW_MS,
    getAppToken,
    forgetAppToken,
    getUserToken,
    storeUserTokens,
    getUserConnection,
    disconnectUser,
    _resetCaches
};
