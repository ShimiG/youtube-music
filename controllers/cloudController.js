// The cloud account: signing in to the app, and keeping this computer's copy
// of the user's data in step with it (services/cloud/sync.js).
//
// There is one sign-in, the cloud account. Before anyone is signed in:
//   GET    /api/cloud/info                 is a cloud address known; may one be given?
//   POST   /api/cloud/login { username, password, url?, registrationCode? }
// And for the person signed in (Settings -> Accounts):
//   GET    /api/cloud/status
//   PUT    /api/cloud/url   { url }        owner only: where the cloud service is
//   DELETE /api/cloud/url                  owner only
//   POST   /api/cloud/link  { password }   sign in again, when the cloud session ran out
//   POST   /api/cloud/sync                 sync now
//   GET    /api/cloud/google/status        ask the cloud whether YouTube is connected
//   GET    /api/cloud/services             ask the cloud what every service is set up with
// The password is turned into a key on this computer and is never sent; the
// session the cloud returns is kept encrypted and never returned.
const bcrypt = require('bcryptjs');
const sync = require('../services/cloud/sync');
const cloudGoogle = require('../services/cloud/google');
const cloudSoundcloud = require('../services/cloud/soundcloud');
const cloudSettings = require('../services/cloud/settings');
const settings = require('../services/appSettings');
const accounts = require('../services/accounts');
const users = require('./UserController');

const { issueToken } = users;

const { CloudError } = sync;

// What went wrong, in the cloud's words where it has any. The cloud's own
// status is passed on for the cases a person can act on; anything else is a
// 502: this server is fine, the service behind it is not.
function sendCloudError(res, err, next) {
    if (!(err instanceof CloudError)) return next(err);
    const passThrough = [400, 401, 403, 409, 413, 423];
    const status = passThrough.includes(err.status) ? err.status : 502;
    return res.status(status).json({ error: err.message, code: `CLOUD_${err.code}` });
}

const statusFor = async (req) => sync.status(req.app.locals.db, req.userId, {
    canConfigure: await settings.isOwner(req.app.locals.db, req.userId)
});

const getStatus = async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await statusFor(req));
    } catch (err) { next(err); }
};

const saveUrl = async (req, res, next) => {
    try {
        const saved = await sync.saveCloudUrl(req.app.locals.db, (req.body || {}).url);
        res.json({ ...(await statusFor(req)), registrationOpen: saved.registrationOpen });
    } catch (err) { sendCloudError(res, err, next); }
};

const clearUrl = async (req, res, next) => {
    try {
        await sync.clearCloudUrl(req.app.locals.db);
        res.json(await statusFor(req));
    } catch (err) { sendCloudError(res, err, next); }
};

// Signs the person in to the cloud again when the session stored here ran out
// (or was refused). It is always the account they are signed in with: another
// account means logging out and signing in as that one.
const link = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        const current = await sync.status(db, req.userId);
        const { username, password } = req.body || {};
        if (current.linked && typeof username === 'string' && username.trim()
            && username.trim().toLowerCase() !== String(current.username).toLowerCase()) {
            return res.status(409).json({
                error: `You are signed in as "${current.username}". To use another cloud account, log out and sign in with it.`,
                code: 'CLOUD_DIFFERENT_ACCOUNT'
            });
        }
        await sync.link(db, req.userId, { username: current.linked ? current.username : username, password });
        // The first run happens now, so the answer already says how it went
        // (and whether the account brings a YouTube login with it).
        const result = await sync.syncNow(db, req.userId);
        return res.json({ ...(await statusFor(req)), result });
    } catch (err) { return sendCloudError(res, err, next); }
};

// --- Signing in to the app ---------------------------------------------------------
//
// The cloud account is the only account there is. Signing in with it on a
// computer sets that computer up: the row that stands for the person here is
// found (or made), the cloud session stored, and the data brought down before
// the first screen is drawn. Accounts from before this (ones the app kept of
// its own, never signed in to a cloud account) are folded into the account of
// whoever signs in (services/accounts.js).

// A cloud address may be given on the login screen while this installation
// has none (and none is built in). Once there is one it is the owner's setting.
const canSetAddress = async (db) => {
    const { url } = await sync.cloudUrl(db);
    return !url && !sync.urlIsFixed();
};

const getInfo = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        const { url } = await sync.cloudUrl(db);
        res.set('Cache-Control', 'no-store');
        res.json({ configured: Boolean(url), canSetAddress: await canSetAddress(db) });
    } catch (err) { next(err); }
};

// The cloud could not be asked at all (as opposed to: it answered "no").
const cloudIsDown = (err) => err instanceof CloudError && (err.code === 'UNREACHABLE' || err.code === 'BAD_RESPONSE' || err.status >= 500);

// The row in `users` that stands for a cloud account on this computer: the
// one already signed in to it; else the oldest account left from before the
// cloud sign-in (it keeps its id, so the installation's owner stays the
// owner); else a new one.
async function localUserFor(db, name) {
    const known = await sync.localUserFor(db, name);
    if (known) return { userId: known, created: false };
    const leftover = await db.get('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM cloud_links) ORDER BY id LIMIT 1');
    if (leftover) return { userId: leftover.id, created: false };
    // The password column cannot be empty; the real verifier is set below.
    const inserted = await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [`cloud:${Date.now()}:${Math.random().toString(36).slice(2)}`, '!']);
    return { userId: inserted.lastID, created: true };
}

const login = async (req, res, next) => {
    const db = req.app.locals.db;
    const { username, password, url, registrationCode } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password
        || username.length > 64 || password.length > 128) {
        return res.status(400).json({ error: 'Enter your user name and password.', code: 'CLOUD_BAD_INPUT' });
    }
    const creating = typeof registrationCode === 'string' && registrationCode.trim().length > 0;
    try {
        // An address typed on the login screen is checked now and kept only
        // once the sign-in has worked: a wrong one must not stick on a
        // computer where nobody is signed in to change it.
        const typed = typeof url === 'string' && url.trim() && await canSetAddress(db)
            ? (await sync.checkCloudUrl(url)).url
            : null;

        let signedIn;
        try {
            signedIn = await sync.cloudSignIn(db, { username, password, registrationCode: creating ? registrationCode : undefined }, { at: typed });
        } catch (err) {
            // No connection: someone who has signed in here before can still
            // get in, against what was kept from that time.
            if (creating || !cloudIsDown(err)) throw err;
            const known = await sync.localUserFor(db, username.trim());
            const row = known && await db.get('SELECT id, password FROM users WHERE id = ?', [known]);
            if (row && await bcrypt.compare(password, row.password)) {
                const linked = await sync.status(db, row.id);
                return res.json({ token: issueToken(row.id), userId: row.id, username: linked.username, offline: true });
            }
            throw err;
        }

        const { session } = signedIn;
        if (typed) await sync.saveCloudUrl(db, typed);
        const { userId, created } = await localUserFor(db, signedIn.name);
        // The name as it was first written here, however it was typed this time.
        const before = await sync.status(db, userId);
        const name = before.linked ? before.username : signedIn.name;
        await sync.storeLink(db, userId, name, session);
        // What accounts from before the cloud sign-in left on this computer
        // becomes this person's, and those accounts go.
        const adopted = await accounts.adoptLocalAccounts(db, userId);
        // The account is known here under its cloud name, and the same name
        // and password open it when the cloud cannot be reached (the password
        // is kept as a one-way hash only).
        const clash = await db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?', [name, userId]);
        await db.run(
            `UPDATE users SET password = ?${clash ? '' : ', username = ?'} WHERE id = ?`,
            clash ? [await users.hashPassword(password), userId] : [await users.hashPassword(password), name, userId]
        );
        // Bring the data down (and send up what was just taken over) before
        // the first screen is drawn. A failure here is not a failed sign-in:
        // the next run tries again.
        await sync.syncNow(db, userId);
        const moved = adopted.accounts > 0 ? { adopted } : {};
        return res.status(created ? 201 : 200).json({ token: issueToken(userId), userId, username: name, ...moved });
    } catch (err) { return sendCloudError(res, err, next); }
};

const googleStatus = async (req, res, next) => {
    try {
        const state = await cloudGoogle.refreshStatus(req.app.locals.db, req.userId);
        res.set('Cache-Control', 'no-store');
        res.json(state || { configured: false, connected: false });
    } catch (err) { sendCloudError(res, err, next); }
};

// Asks the cloud what the installation's services are set up with and which
// of them this account has connected, and remembers it (the Accounts screen
// and the sources list read what is remembered).
const servicesStatus = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        const [google, soundcloud, settings] = await Promise.all([
            cloudGoogle.refreshStatus(db, req.userId),
            cloudSoundcloud.refreshStatus(db, req.userId),
            cloudSettings.refresh(db, req.userId)
        ]);
        res.set('Cache-Control', 'no-store');
        res.json({
            youtube: google || { configured: false, connected: false },
            soundcloud: soundcloud || { configured: false, connected: false },
            audius: { configured: Boolean(settings && settings.audius) }
        });
    } catch (err) { sendCloudError(res, err, next); }
};

const syncNow = async (req, res, next) => {
    try {
        const result = await sync.syncNow(req.app.locals.db, req.userId);
        res.json({ ...(await statusFor(req)), result });
    } catch (err) { next(err); }
};

module.exports = { getStatus, saveUrl, clearUrl, link, syncNow, getInfo, login, googleStatus, servicesStatus };
