// Cloud sync, as Settings -> Accounts uses it (services/cloud/sync.js):
//   GET    /api/cloud/status
//   PUT    /api/cloud/url   { url }        owner only: where the cloud service is
//   DELETE /api/cloud/url                  owner only
//   POST   /api/cloud/link  { username, password, registrationCode? }
//   DELETE /api/cloud/link                 stop syncing on this computer
//   POST   /api/cloud/sync                 sync now
// The password is turned into a key on this computer and is never stored or
// sent; the session the cloud returns is kept encrypted and never returned.
const sync = require('../services/cloud/sync');
const settings = require('../services/appSettings');

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
        // The first run happens now, so the answer already says how it went.
        const result = await sync.syncNow(db, req.userId);
        res.json({ ...(await statusFor(req)), result });
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

module.exports = { getStatus, saveUrl, clearUrl, link, unlink, syncNow };
