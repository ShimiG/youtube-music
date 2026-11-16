// SoundCloud through the cloud account (docs/cloud-data.md, "Secrets").
//
// The cloud service holds this installation's SoundCloud credentials, as it
// holds Google's, so a computer needs none. What a computer gets from it:
//
//   - the installation's "app" token, for search and for playing public
//     tracks. SoundCloud issues few of those, so the cloud keeps one and
//     every signed-in computer shares it (kept here until it runs out);
//   - an account's own token, once that account has connected its SoundCloud
//     login through the cloud (its playlists and likes). Connected once, on
//     any computer, it is connected on all.
//
// Remembered between calls, as the cloud last reported them: whether the cloud
// service has SoundCloud credentials at all, and whether this user's cloud
// account has SoundCloud connected.
const client = require('./client');
const sync = require('./sync');

const { CloudError } = client;
const CONFIGURED_KEY = 'cloud_soundcloud_configured';
// A token this close to its end is asked for again.
const EXPIRY_SKEW_MS = 60 * 1000;

let configured = false; // the cloud service has SoundCloud credentials
let appMemo = null;     // { accessToken, expiresAt }: the installation's token
let appInFlight = null; // one request to the cloud at a time

/** Loads what was last known, at start-up. */
async function load(db) {
    configured = (await sync.getMeta(db, CONFIGURED_KEY)) === '1';
}

/** Whether SoundCloud works through the cloud (as last reported). */
const available = () => configured;

async function remember(db, userId, state) {
    if (typeof state.configured === 'boolean' && state.configured !== configured) {
        configured = state.configured;
        if (!configured) appMemo = null;
        await sync.setMeta(db, CONFIGURED_KEY, configured ? '1' : '0');
    }
    if (typeof state.connected === 'boolean' && userId) {
        await db.run('UPDATE cloud_links SET soundcloud_connected = ? WHERE user_id = ?', [state.connected ? 1 : 0, userId]);
    }
}

/** Whether this user's cloud account has SoundCloud connected (as last reported). */
async function connected(db, userId) {
    const row = await db.get(`SELECT soundcloud_connected FROM cloud_links WHERE user_id = ? AND state = 'ok'`, [userId]);
    return Boolean(row && row.soundcloud_connected);
}

/** Asks the cloud and remembers the answer. Null when the user is not signed in to it. */
async function refreshStatus(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    const state = await client.request(session.url, '/soundcloud/status', { token: session.token });
    await remember(db, userId, { configured: Boolean(state && state.configured), connected: Boolean(state && state.connected) });
    return { configured, connected: Boolean(state && state.connected) };
}

/**
 * The address of SoundCloud's consent page, by way of the cloud. Null when
 * this user cannot connect that way (not signed in, or the cloud service has
 * no SoundCloud credentials).
 */
async function startConnect(db, userId, { returnTo } = {}) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    try {
        const answer = await client.request(session.url, '/soundcloud/start', { method: 'POST', token: session.token, body: { returnTo } });
        await remember(db, userId, { configured: true });
        return answer && typeof answer.url === 'string' ? answer.url : null;
    } catch (err) {
        if (err instanceof CloudError && err.code === 'SOUNDCLOUD_NOT_CONFIGURED') {
            await remember(db, userId, { configured: false });
            return null;
        }
        throw err;
    }
}

const usable = (answer) => (answer && typeof answer.accessToken === 'string'
    ? { accessToken: answer.accessToken, expiresAt: Number(answer.expiresAt) || Date.now() + 3500 * 1000 }
    : null);

/**
 * This account's SoundCloud token from the cloud: { accessToken, expiresAt },
 * or null when the cloud account has no SoundCloud connection (or the user is
 * not signed in). Throws CloudError when the cloud or SoundCloud cannot be reached.
 */
async function accessToken(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    try {
        const token = usable(await client.request(session.url, '/soundcloud/token', { method: 'POST', token: session.token }));
        if (token) await remember(db, userId, { configured: true, connected: true });
        return token;
    } catch (err) {
        if (err instanceof CloudError && (err.code === 'SOUNDCLOUD_NOT_CONNECTED' || err.code === 'SOUNDCLOUD_NOT_CONFIGURED')) {
            await remember(db, userId, { connected: false, ...(err.code === 'SOUNDCLOUD_NOT_CONFIGURED' ? { configured: false } : {}) });
            return null;
        }
        throw err;
    }
}

// Any account signed in on this computer will do for the installation's token.
async function anySession(db) {
    const rows = await db.all(`SELECT user_id FROM cloud_links WHERE state = 'ok' ORDER BY user_id`);
    for (const { user_id: userId } of rows) {
        const session = await sync.sessionFor(db, userId);
        if (session) return session;
    }
    return null;
}

/**
 * The installation's SoundCloud token from the cloud: the access token, or
 * null when the cloud cannot give one (nobody signed in here, or it has no
 * SoundCloud credentials). Throws CloudError when it cannot be reached.
 */
async function appToken(db) {
    if (appMemo && appMemo.expiresAt > Date.now() + EXPIRY_SKEW_MS) return appMemo.accessToken;
    if (appInFlight) return appInFlight;
    appInFlight = (async () => {
        const session = await anySession(db);
        if (!session) return null;
        try {
            const token = usable(await client.request(session.url, '/soundcloud/app-token', { method: 'POST', token: session.token }));
            if (!token) return null;
            appMemo = token;
            await remember(db, null, { configured: true });
            return token.accessToken;
        } catch (err) {
            if (err instanceof CloudError && err.code === 'SOUNDCLOUD_NOT_CONFIGURED') {
                await remember(db, null, { configured: false });
                return null;
            }
            throw err;
        }
    })().finally(() => { appInFlight = null; });
    return appInFlight;
}

/** Drops the remembered installation token (SoundCloud refused it). */
function forgetAppToken() { appMemo = null; }

/** Disconnects SoundCloud from the cloud account (on every computer). */
async function disconnect(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return false;
    await client.request(session.url, '/soundcloud', { method: 'DELETE', token: session.token });
    await remember(db, userId, { connected: false });
    return true;
}

// Tests only.
function _reset() { configured = false; appMemo = null; appInFlight = null; }

module.exports = { load, available, connected, refreshStatus, startConnect, accessToken, appToken, forgetAppToken, disconnect, _reset };
