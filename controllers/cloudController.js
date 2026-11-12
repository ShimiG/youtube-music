// Cloud sync, as Settings -> Accounts uses it (services/cloud/sync.js):
//   GET    /api/cloud/status
//   PUT    /api/cloud/url   { url }        owner only: where the cloud service is
//   DELETE /api/cloud/url                  owner only
//   POST   /api/cloud/link  { username, password, registrationCode? }
//   DELETE /api/cloud/link                 stop syncing on this computer
//   POST   /api/cloud/sync                 sync now
//   GET    /api/cloud/google/status        ask the cloud whether YouTube is connected
// And, before anyone is logged in (the login screen):
//   GET    /api/cloud/info                 can this computer sign in with a cloud account?
//   POST   /api/cloud/login { username, password, url? }
// The password is turned into a key on this computer and is never sent; the
// session the cloud returns is kept encrypted and never returned.
const bcrypt = require('bcryptjs');
const sync = require('../services/cloud/sync');
const cloudGoogle = require('../services/cloud/google');
const settings = require('../services/appSettings');
const { issueToken, hashPassword } = require('./UserController');

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

const link = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        const { username, password, registrationCode } = req.body || {};
        await sync.link(db, req.userId, { username, password, registrationCode });
        // The first run happens now, so the answer already says how it went
        // (and whether the account brings a YouTube login with it).
        const result = await sync.syncNow(db, req.userId);
        res.json({ ...(await statusFor(req)), result });
    } catch (err) { sendCloudError(res, err, next); }
};

// --- Signing in to the app with the cloud account ----------------------------------
//
// On a computer that has never seen the user, the cloud account is the only
// thing they have. Signing in with it creates the account on this computer,
// links it, and brings the data down, in one step.

const userCount = async (db) => (await db.get('SELECT COUNT(*) AS n FROM users')).n;

// The address may be given on the login screen only on a computer nobody has
// used yet (after that it is the owner's setting, like everything else).
const canSetAddress = async (db) => {
    const { url } = await sync.cloudUrl(db);
    return !url && !sync.urlIsFixed() && (await userCount(db)) === 0;
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

const login = async (req, res, next) => {
    const db = req.app.locals.db;
    const { username, password, url } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password
        || username.length > 64 || password.length > 128) {
        return res.status(400).json({ error: 'Enter the cloud account\'s user name and password.', code: 'CLOUD_BAD_INPUT' });
    }
    try {
        // An address typed on the login screen is checked now and kept only
        // once the sign-in has worked: a wrong one must not stick on a
        // computer where nobody is logged in to change it.
        const typed = typeof url === 'string' && url.trim() && await canSetAddress(db)
            ? (await sync.checkCloudUrl(url)).url
            : null;

        let signedIn;
        try {
            signedIn = await sync.cloudSignIn(db, { username, password }, { at: typed });
        } catch (err) {
            // No connection: someone who has signed in here before can still
            // get in, against what was kept from that time.
            if (!cloudIsDown(err)) throw err;
            const known = await sync.localUserFor(db, username.trim());
            const row = known && await db.get('SELECT id, username, password FROM users WHERE id = ?', [known]);
            if (row && await bcrypt.compare(password, row.password)) {
                return res.json({ token: issueToken(row.id), userId: row.id, username: row.username, offline: true });
            }
            throw err;
        }

        const { name, session } = signedIn;
        if (typed) await sync.saveCloudUrl(db, typed);
        let userId = await sync.localUserFor(db, name);
        let created = false;
        if (!userId) {
            // An account of that name that is not linked to the cloud account
            // is someone's local account: not ours to hand over.
            const taken = await db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [name]);
            if (taken) {
                return res.status(409).json({
                    error: `This computer already has an account named "${name}". Log in to it with its own password, then link it under Settings, Accounts.`,
                    code: 'CLOUD_LOCAL_ACCOUNT_EXISTS'
                });
            }
            // The same name and password then also open the account here when
            // the cloud cannot be reached (kept as a one-way hash, like any
            // local password).
            const inserted = await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [name, await hashPassword(password)]);
            userId = inserted.lastID;
            created = true;
        }
        await sync.storeLink(db, userId, name, session);
        // Bring the data down before the first screen is drawn. A failure
        // here is not a failed login: the next run tries again.
        await sync.syncNow(db, userId);
        const user = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
        res.status(created ? 201 : 200).json({ token: issueToken(userId), userId, username: user.username });
    } catch (err) { sendCloudError(res, err, next); }
};

const googleStatus = async (req, res, next) => {
    try {
        const state = await cloudGoogle.refreshStatus(req.app.locals.db, req.userId);
        res.set('Cache-Control', 'no-store');
        res.json(state || { configured: false, connected: false });
    } catch (err) { sendCloudError(res, err, next); }
};

const unlink = async (req, res, next) => {
    try {
        await sync.unlink(req.app.locals.db, req.userId);
        res.json(await statusFor(req));
    } catch (err) { next(err); }
};

const syncNow = async (req, res, next) => {
    try {
        const result = await sync.syncNow(req.app.locals.db, req.userId);
        res.json({ ...(await statusFor(req)), result });
    } catch (err) { next(err); }
};

module.exports = { getStatus, saveUrl, clearUrl, link, unlink, syncNow, getInfo, login, googleStatus };
