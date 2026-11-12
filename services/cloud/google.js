// YouTube through the cloud account (docs/cloud-data.md, "Secrets").
//
// The cloud service can hold this installation's Google credentials and the
// user's YouTube login. A computer linked to the cloud account then needs
// neither: it asks the cloud for a short-lived access token when it needs
// one. Connect YouTube once, on any computer, and it is connected on all.
//
// Two things are remembered between calls, as the cloud last reported them:
// whether the cloud service can do the Google sign-in at all (installation
// wide), and whether this user's cloud account has YouTube connected.
const client = require('./client');
const sync = require('./sync');

const { CloudError } = client;
const CONFIGURED_KEY = 'cloud_google_configured';

let configured = false; // the cloud service has Google credentials

/** Loads what was last known, at start-up. */
async function load(db) {
    configured = (await sync.getMeta(db, CONFIGURED_KEY)) === '1';
}

/** Whether YouTube can be connected through the cloud (as last reported). */
const available = () => configured;

async function remember(db, userId, state) {
    if (typeof state.configured === 'boolean' && state.configured !== configured) {
        configured = state.configured;
        await sync.setMeta(db, CONFIGURED_KEY, configured ? '1' : '0');
    }
    if (typeof state.connected === 'boolean') {
        await db.run('UPDATE cloud_links SET google_connected = ? WHERE user_id = ?', [state.connected ? 1 : 0, userId]);
    }
}

/** Whether this user's cloud account has YouTube connected (as last reported). */
async function connected(db, userId) {
    const row = await db.get(`SELECT google_connected FROM cloud_links WHERE user_id = ? AND state = 'ok'`, [userId]);
    return Boolean(row && row.google_connected);
}

/** Asks the cloud and remembers the answer. Null when the user is not linked. */
async function refreshStatus(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    const state = await client.request(session.url, '/google/status', { token: session.token });
    await remember(db, userId, { configured: Boolean(state && state.configured), connected: Boolean(state && state.connected) });
    return { configured, connected: Boolean(state && state.connected) };
}

/**
 * The address of Google's consent page, by way of the cloud. Null when this
 * user cannot connect YouTube that way (not linked, or the cloud service has
 * no Google credentials).
 */
async function startConnect(db, userId, { returnTo, scope } = {}) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    try {
        const answer = await client.request(session.url, '/google/start', {
            method: 'POST', token: session.token, body: { returnTo, ...(scope === 'write' ? { scope: 'write' } : {}) }
        });
        await remember(db, userId, { configured: true });
        return answer && typeof answer.url === 'string' ? answer.url : null;
    } catch (err) {
        if (err instanceof CloudError && err.code === 'GOOGLE_NOT_CONFIGURED') {
            await remember(db, userId, { configured: false });
            return null;
        }
        throw err;
    }
}

/**
 * A YouTube access token from the cloud: { accessToken, expiresAt }, or null
 * when the cloud account has no YouTube connection (or the user is not linked).
 * Throws CloudError when the cloud or Google cannot be reached.
 */
async function accessToken(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return null;
    try {
        const answer = await client.request(session.url, '/google/token', { method: 'POST', token: session.token });
        if (!answer || typeof answer.accessToken !== 'string') return null;
        await remember(db, userId, { configured: true, connected: true });
        return { accessToken: answer.accessToken, expiresAt: Number(answer.expiresAt) || Date.now() + 3500 * 1000 };
    } catch (err) {
        if (err instanceof CloudError && (err.code === 'GOOGLE_NOT_CONNECTED' || err.code === 'GOOGLE_NOT_CONFIGURED')) {
            await remember(db, userId, { connected: false, ...(err.code === 'GOOGLE_NOT_CONFIGURED' ? { configured: false } : {}) });
            return null;
        }
        throw err;
    }
}

/** Disconnects YouTube from the cloud account (on every computer). */
async function disconnect(db, userId) {
    const session = await sync.sessionFor(db, userId);
    if (!session) return false;
    await client.request(session.url, '/google', { method: 'DELETE', token: session.token });
    await remember(db, userId, { connected: false });
    return true;
}

// Tests only.
function _reset() { configured = false; }

module.exports = { load, available, connected, refreshStatus, startConnect, accessToken, disconnect, _reset };
