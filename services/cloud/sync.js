// Cloud sync (docs/cloud-data.md): keeps a user's custom playlists and play
// history the same on every computer linked to their cloud account.
//
// The local database stays in charge. One sync run, for one user:
//   1. Read the user's records as they are now (records.collect) and compare
//      them with what this computer and the cloud last agreed on
//      (sync_records): anything different or new has changed here, anything
//      missing has been deleted here.
//   2. Push those changes.
//   3. Pull what the cloud accepted since this computer last looked, and
//      write what is newer than the local copy into the tables.
// For one record the newer change wins, on every computer and in the cloud
// alike (equal times: the larger device id). Nothing in the app has to tell
// the sync what changed, so no place that edits data can be forgotten.
//
// Runs are started shortly after a change (touch), every few minutes, and on
// demand. A failure is kept as the link's last error and tried again on the
// next run; nothing is lost, because every computer has a complete copy.
const crypto = require('crypto');
const { encrypt, decrypt } = require('../tokenCrypto');
const client = require('./client');
const records = require('./records');

const { CloudError } = client;

const PUSH_BATCH = 200;
const PULL_PAGE = 200;
const MAX_PAGES_PER_RUN = 100; // 20,000 records: far above anything real
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_DELAY_MS = 4000;
const INTERVAL_MS = 5 * 60 * 1000;
const START_DELAY_MS = 30 * 1000;

// --- Installation-wide values -------------------------------------------------

async function getMeta(db, key) {
    const row = await db.get('SELECT value FROM app_meta WHERE key = ?', [key]);
    return row ? row.value : null;
}

async function setMeta(db, key, value) {
    await db.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

/** This installation's id in the cloud's eyes; made once, never changes. */
async function deviceId(db) {
    let id = await getMeta(db, 'device_id');
    if (!id) {
        id = `mm-${crypto.randomBytes(12).toString('hex')}`;
        await setMeta(db, 'device_id', id);
    }
    return id;
}

// The address a build was made with (scripts/build-sea.mjs replaces this
// expression with the CLOUD_URL of the build, if there was one), so an
// installed copy can know its cloud service without anyone typing it.
const BUILT_IN_URL = process.env.BUILT_IN_CLOUD_URL || '';

/**
 * { url, fromEnv }: CLOUD_URL (the environment or .env), then the address
 * built into this copy, then the one saved in the app. The first two cannot
 * be changed from the app.
 */
async function cloudUrl(db) {
    const fixed = process.env.CLOUD_URL || BUILT_IN_URL;
    if (fixed) {
        try {
            return { url: client.normalizeUrl(fixed), fromEnv: true };
        } catch {
            return { url: null, fromEnv: true };
        }
    }
    return { url: await getMeta(db, 'cloud_url'), fromEnv: false };
}

const urlIsFixed = () => Boolean(process.env.CLOUD_URL || BUILT_IN_URL);

/** Checks that an address answers like our cloud service: { url, registrationOpen }. Saves nothing. */
async function checkCloudUrl(raw) {
    const url = client.normalizeUrl(raw);
    const notOurs = () => new CloudError('BAD_URL', 'That address answered, but it is not a Music Manager cloud service.', 400);
    let health;
    try {
        health = await client.request(url, '/health');
    } catch (err) {
        // Some other site, answering "not found" or with a page: the same
        // thing to the person typing. Not reachable at all stays as it is.
        if (err instanceof CloudError && err.code !== 'UNREACHABLE') throw notOurs();
        throw err;
    }
    if (!health || health.service !== 'music-manager-cloud') throw notOurs();
    return { url, registrationOpen: Boolean(health.registrationOpen) };
}

/** Checks that the address answers like our cloud service, then saves it. */
async function saveCloudUrl(db, raw) {
    if (urlIsFixed()) throw new CloudError('URL_FROM_ENV', 'The cloud address is fixed for this copy of the app and cannot be changed here.', 409);
    const checked = await checkCloudUrl(raw);
    await setMeta(db, 'cloud_url', checked.url);
    return checked;
}

async function clearCloudUrl(db) {
    if (urlIsFixed()) throw new CloudError('URL_FROM_ENV', 'The cloud address is fixed for this copy of the app and cannot be changed here.', 409);
    await db.run(`DELETE FROM app_meta WHERE key = 'cloud_url'`);
}

// --- Links ----------------------------------------------------------------------

const getLink = (db, userId) => db.get('SELECT * FROM cloud_links WHERE user_id = ?', [userId]);

async function pendingCount(db, userId) {
    const row = await db.get('SELECT COUNT(*) AS n FROM sync_records WHERE user_id = ? AND dirty = 1', [userId]);
    return row ? row.n : 0;
}

/** What Settings shows. Never includes the session. */
async function status(db, userId, { canConfigure = false } = {}) {
    const { url, fromEnv } = await cloudUrl(db);
    const link = await getLink(db, userId);
    return {
        configured: Boolean(url),
        url,
        urlFromEnv: fromEnv,
        canConfigure: Boolean(canConfigure) && !fromEnv,
        linked: Boolean(link),
        username: link ? link.username : null,
        state: link ? link.state : 'off',
        syncing: running.has(userId),
        lastSyncAt: link ? link.last_sync_at : null,
        lastError: link ? link.last_error : null,
        pending: link ? await pendingCount(db, userId) : 0,
        // YouTube by way of the cloud account (services/cloud/google.js).
        youtube: {
            available: Boolean(link) && require('./google').available(),
            connected: Boolean(link && link.state === 'ok' && link.google_connected)
        }
    };
}

/** Signs in to the cloud (or creates the account, given a registration code): the session. */
async function cloudSignIn(db, { username, password, registrationCode } = {}, { at = null } = {}) {
    // `at`: an address that was checked but is not saved yet (the login
    // screen of a new computer saves it only once the sign-in has worked).
    const url = at || (await cloudUrl(db)).url;
    if (!url) throw new CloudError('NOT_CONFIGURED', 'The cloud address has not been set on this computer yet.', 409);
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
        throw new CloudError('BAD_INPUT', 'Enter the cloud account\'s user name and password.', 400);
    }
    const name = username.trim();
    const authKey = await client.deriveAuthKey(name, password);
    const creating = typeof registrationCode === 'string' && registrationCode.trim().length > 0;
    const session = creating
        ? await client.request(url, '/auth/register', { method: 'POST', body: { username: name, authKey, registrationCode: registrationCode.trim() } })
        : await client.request(url, '/auth/login', { method: 'POST', body: { username: name, authKey } });
    if (!session || typeof session.token !== 'string') throw new CloudError('BAD_RESPONSE', 'The cloud service did not return a session.');
    return { name, session };
}

/** Records that a local user is linked to a cloud account, with its session. */
async function storeLink(db, userId, name, session) {
    // A link to another account (or a first link) starts from nothing agreed:
    // everything here is compared with everything there on the first run.
    const previous = await getLink(db, userId);
    const sameAccount = previous && previous.username.toLowerCase() === name.toLowerCase();
    if (!sameAccount) await db.run('DELETE FROM sync_records WHERE user_id = ?', [userId]);
    await db.run(
        `INSERT INTO cloud_links (user_id, username, session, session_expires_at, cursor, state, last_error, linked_at)
         VALUES (?, ?, ?, ?, ?, 'ok', NULL, ?)
         ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, session = excluded.session,
            session_expires_at = excluded.session_expires_at, cursor = excluded.cursor, state = 'ok', last_error = NULL`,
        [userId, name, encrypt(session.token), Number(session.expiresAt) || 0, sameAccount ? previous.cursor : 0, Date.now()]
    );
    linked.add(userId);
}

/**
 * Signs this user in to the cloud (or creates the cloud account when a
 * registration code is given) and links this computer to it. The password is
 * turned into a key here and is neither sent nor stored.
 */
async function link(db, userId, credentials) {
    const { name, session } = await cloudSignIn(db, credentials);
    await storeLink(db, userId, name, session);
}

/**
 * The address and session to call the cloud with for a linked user, or null
 * when they are not linked (or have to sign in again).
 */
async function sessionFor(db, userId) {
    const row = await getLink(db, userId);
    if (!row || row.state !== 'ok') return null;
    const { url } = await cloudUrl(db);
    const token = decrypt(row.session);
    return url && token ? { url, token } : null;
}

/** The local user linked to a cloud account name, if any. */
async function localUserFor(db, cloudName) {
    const row = await db.get('SELECT user_id FROM cloud_links WHERE lower(username) = lower(?)', [String(cloudName)]);
    return row ? row.user_id : null;
}

/** Stops syncing this user. Their data stays here and in the cloud. */
async function unlink(db, userId) {
    linked.delete(userId);
    // A YouTube login that came from the cloud account goes with it (it is a
    // short-lived token with nothing here to renew it). One connected on this
    // computer with its own credentials stays.
    const row = await getLink(db, userId);
    if (row && row.google_connected) {
        await db.run(
            `DELETE FROM user_connections WHERE user_id = ? AND refresh_token IS NULL
             AND source_id = (SELECT id FROM sources WHERE name = 'youtube')`,
            [userId]
        );
    }
    await db.run('DELETE FROM cloud_links WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM sync_records WHERE user_id = ?', [userId]);
}

// --- One sync run -----------------------------------------------------------------

// Whether a change from the cloud beats what this computer has for the record.
function cloudWins(change, known, ourDeviceId) {
    if (!known) return true;
    if (change.updatedAt !== known.updated_at) return change.updatedAt > known.updated_at;
    // Same time. A record this computer changed and has not sent yet is "from
    // us"; the cloud's rule for equal times is the larger device id.
    if (known.dirty) return String(change.deviceId) > ourDeviceId;
    return false; // what we already agreed on
}

async function detectLocalChanges(db, userId, local) {
    const now = Date.now();
    const known = new Map();
    for (const row of await db.all('SELECT collection, record_id, hash, updated_at, deleted, dirty FROM sync_records WHERE user_id = ?', [userId])) {
        known.set(records.keyOf(row.collection, row.record_id), row);
    }
    const upsert = (collection, id, hash, updatedAt, deleted) => db.run(
        `INSERT INTO sync_records (user_id, collection, record_id, hash, updated_at, deleted, dirty) VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(user_id, collection, record_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at, deleted = excluded.deleted, dirty = 1`,
        [userId, collection, id, hash, updatedAt, deleted ? 1 : 0]
    );
    // One transaction: linking a computer with a full library marks every
    // record at once.
    await db.transaction(async () => {
    for (const [key, record] of local) {
        const hash = records.hashOf(record.data);
        const row = known.get(key);
        if (row && !row.deleted && row.hash === hash) continue; // unchanged
        // New to the cloud: dated by the record itself where it can be (when
        // the playlist was made, when the track was played), so that data from
        // before linking merges by its real age. Changed since: dated by the
        // record where it carries its own time (a play), otherwise now. Never
        // older than the version it replaces, or the change would be ignored.
        const updatedAt = row
            ? Math.max(record.changed || now, row.updated_at + 1)
            : (record.firstSeen || now);
        await upsert(record.collection, record.id, hash, updatedAt, false);
    }
    for (const [key, row] of known) {
        if (row.deleted || local.has(key)) continue;
        await upsert(row.collection, row.record_id, row.hash, Math.max(now, row.updated_at + 1), true); // deleted here
    }
    });
}

async function pushChanges(db, userId, url, token, device, local) {
    for (;;) {
        const dirty = await db.all(
            `SELECT collection, record_id, updated_at, deleted FROM sync_records
             WHERE user_id = ? AND dirty = 1
             ORDER BY CASE collection WHEN 'playlists' THEN 0 WHEN 'playlist_tracks' THEN 1 ELSE 2 END, updated_at
             LIMIT ?`,
            [userId, PUSH_BATCH]
        );
        if (dirty.length === 0) return;
        const changes = dirty.map((row) => {
            const record = local.get(records.keyOf(row.collection, row.record_id));
            return row.deleted || !record
                ? { collection: row.collection, id: row.record_id, updatedAt: row.updated_at, deleted: true }
                : { collection: row.collection, id: row.record_id, updatedAt: row.updated_at, data: record.data };
        });
        await client.request(url, '/sync/push', { method: 'POST', token, body: { deviceId: device, changes } });
        for (const row of dirty) {
            // Only what was sent: a record changed again meanwhile stays dirty.
            await db.run(
                'UPDATE sync_records SET dirty = 0 WHERE user_id = ? AND collection = ? AND record_id = ? AND updated_at = ?',
                [userId, row.collection, row.record_id, row.updated_at]
            );
        }
    }
}

async function pullChanges(db, userId, url, token, device, cursor) {
    let since = cursor;
    const applied = []; // keys of the records written into the tables
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
        const answer = await client.request(url, `/sync/pull?since=${since}&limit=${PULL_PAGE}`, { token });
        const changes = Array.isArray(answer && answer.changes) ? answer.changes : [];
        // Playlists before their tracks within a page.
        changes.sort((a, b) => records.COLLECTIONS.indexOf(a.collection) - records.COLLECTIONS.indexOf(b.collection) || a.seq - b.seq);
        // A page is applied as one transaction (only database calls inside):
        // the first sync on a new computer writes hundreds of rows.
        await db.transaction(async () => { for (const change of changes) {
            if (!change || typeof change.collection !== 'string' || typeof change.id !== 'string' || !Number.isSafeInteger(change.updatedAt)) continue;
            const known = await db.get(
                'SELECT hash, updated_at, deleted, dirty FROM sync_records WHERE user_id = ? AND collection = ? AND record_id = ?',
                [userId, change.collection, change.id]
            );
            if (!cloudWins(change, known, device)) continue;
            const usable = await records.apply(db, userId, change);
            // A record that cannot be used here (its playlist is gone, a source
            // this version does not know) is remembered as "not here", so it is
            // neither applied again nor mistaken for something deleted here.
            await db.run(
                `INSERT INTO sync_records (user_id, collection, record_id, hash, updated_at, deleted, dirty) VALUES (?, ?, ?, ?, ?, ?, 0)
                 ON CONFLICT(user_id, collection, record_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at, deleted = excluded.deleted, dirty = 0`,
                [userId, change.collection, change.id, change.deleted || !usable ? '' : records.hashOf(change.data), change.updatedAt, change.deleted || !usable ? 1 : 0]
            );
            if (usable && !change.deleted) applied.push(records.keyOf(change.collection, change.id));
            else if (usable) applied.push(null); // a deletion: applied, nothing to settle
        }
        since = Number.isSafeInteger(answer && answer.cursor) ? answer.cursor : since;
        await db.run('UPDATE cloud_links SET cursor = ? WHERE user_id = ?', [since, userId]);
        }); // the cursor moves with the page it belongs to
        if (!answer || !answer.more) break;
    }
    return applied;
}

// After applying, what collect() reads back for those records is what was
// agreed, exactly as this computer stores it (cleaned text, whole seconds), so
// the next run does not mistake it for a local change. Only the records just
// applied: anything else that differs is a change made here meanwhile.
async function settleHashes(db, userId, appliedKeys) {
    const keys = new Set(appliedKeys.filter(Boolean));
    if (keys.size === 0) return;
    const local = await records.collect(db, userId);
    for (const [key, record] of local) {
        if (!keys.has(key)) continue;
        await db.run(
            'UPDATE sync_records SET hash = ? WHERE user_id = ? AND collection = ? AND record_id = ? AND dirty = 0 AND deleted = 0',
            [records.hashOf(record.data), userId, record.collection, record.id]
        );
    }
}

async function renewSession(db, userId, url, linkRow, token) {
    if (linkRow.session_expires_at - Date.now() > RENEW_BEFORE_MS) return token;
    try {
        const fresh = await client.request(url, '/auth/refresh', { method: 'POST', token });
        if (fresh && typeof fresh.token === 'string') {
            await db.run('UPDATE cloud_links SET session = ?, session_expires_at = ? WHERE user_id = ?',
                [encrypt(fresh.token), Number(fresh.expiresAt) || 0, userId]);
            return fresh.token;
        }
    } catch (err) {
        // An older cloud service without /auth/refresh: carry on with the
        // session we have. A rejected session is handled by the caller.
        if (err.code === 'NOT_SIGNED_IN') throw err;
    }
    return token;
}

async function runSync(db, userId) {
    const linkRow = await getLink(db, userId);
    if (!linkRow) return { ok: false, reason: 'not_linked' };
    if (linkRow.state === 'signin_required') return { ok: false, reason: 'signin_required' };
    const { url } = await cloudUrl(db);
    if (!url) return { ok: false, reason: 'not_configured' };

    try {
        let token = decrypt(linkRow.session);
        if (!token) throw new CloudError('NOT_SIGNED_IN', 'The saved cloud session could not be read on this computer.', 401);
        token = await renewSession(db, userId, url, linkRow, token);
        const device = await deviceId(db);

        const local = await records.collect(db, userId);
        await detectLocalChanges(db, userId, local);
        await pushChanges(db, userId, url, token, device, local);
        const applied = await pullChanges(db, userId, url, token, device, linkRow.cursor);
        if (applied.length > 0) {
            await records.trimHistory(db, userId);
            await settleHashes(db, userId, applied);
        }
        await db.run(`UPDATE cloud_links SET last_sync_at = ?, last_error = NULL, state = 'ok' WHERE user_id = ?`, [Date.now(), userId]);
        // Also learn whether YouTube was connected (or disconnected) on
        // another computer since the last run. Never a reason to fail the run.
        try {
            await require('./google').refreshStatus(db, userId);
        } catch { /* asked again on the next run */ }
        return { ok: true, applied: applied.length };
    } catch (err) {
        if (!(err instanceof CloudError)) throw err;
        // The cloud no longer accepts the session (expired, or the account is
        // gone): stop trying until the user signs in again.
        const signInAgain = err.code === 'NOT_SIGNED_IN';
        await db.run('UPDATE cloud_links SET last_error = ?, state = ? WHERE user_id = ?',
            [err.message.slice(0, 300), signInAgain ? 'signin_required' : 'ok', userId]);
        if (signInAgain) linked.delete(userId);
        return { ok: false, reason: signInAgain ? 'signin_required' : 'failed', error: err.message };
    }
}

// --- Scheduling --------------------------------------------------------------------

const running = new Map(); // userId -> Promise of the run in progress
const linked = new Set(); // users worth scheduling runs for
const timers = new Map(); // userId -> timer of the run that is due
let started = null; // { db, interval, startTimer } once start() was called

/** One run for a user; a call during a run joins it. */
function syncNow(db, userId) {
    if (running.has(userId)) return running.get(userId);
    const run = runSync(db, userId)
        .catch((err) => {
            console.error(`Cloud sync failed for user ${userId}: ${err.message}`);
            return { ok: false, reason: 'failed', error: 'Sync failed on this computer.' };
        })
        .finally(() => running.delete(userId));
    running.set(userId, run);
    return run;
}

/** Call after something of the user's changed: a run follows shortly. */
function touch(userId) {
    if (!started || !linked.has(userId) || timers.has(userId)) return;
    const timer = setTimeout(() => {
        timers.delete(userId);
        syncNow(started.db, userId);
    }, TOUCH_DELAY_MS);
    if (timer.unref) timer.unref();
    timers.set(userId, timer);
}

/** Starts background syncing for every linked user (server.js). */
async function start(db) {
    if (started) return;
    await require('./google').load(db);
    const rows = await db.all(`SELECT user_id FROM cloud_links WHERE state = 'ok'`);
    for (const row of rows) linked.add(row.user_id);
    const all = () => { for (const userId of linked) syncNow(db, userId); };
    const interval = setInterval(all, INTERVAL_MS);
    const startTimer = setTimeout(all, START_DELAY_MS);
    if (interval.unref) interval.unref();
    if (startTimer.unref) startTimer.unref();
    started = { db, interval, startTimer };
}

// Tests only.
function _reset() {
    if (started) {
        clearInterval(started.interval);
        clearTimeout(started.startTimer);
    }
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    running.clear();
    linked.clear();
    started = null;
    require('./google')._reset();
}

module.exports = {
    CloudError,
    status,
    saveCloudUrl,
    clearCloudUrl,
    link,
    checkCloudUrl,
    cloudSignIn,
    storeLink,
    sessionFor,
    localUserFor,
    cloudUrl,
    urlIsFixed,
    getMeta,
    setMeta,
    unlink,
    syncNow,
    touch,
    start,
    deviceId,
    _reset
};
