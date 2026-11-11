// Settings -> Accounts: this installation's service credentials.
//   GET    /api/settings/services           what is set up (never the values)
//   PUT    /api/settings/services/:source   { values: { KEY: '...' } }  owner only
//   DELETE /api/settings/services/:source                               owner only
// See services/appSettings.js.
const settings = require('../services/appSettings');
const soundcloudTokens = require('../controllers/soundcloud/tokens');

function sendSettingsError(res, err, next) {
    if (err instanceof settings.SettingsError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    return next(err);
}

// A new SoundCloud app invalidates the app-level token of the old one.
async function afterChange(db, source) {
    if (source === 'soundcloud') await soundcloudTokens.forgetAppToken(db);
}

const listServices = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        res.set('Cache-Control', 'no-store');
        res.json({ services: settings.describe(await settings.isOwner(db, req.userId)) });
    } catch (err) { next(err); }
};

const requireOwner = async (req, res, next) => {
    try {
        if (await settings.isOwner(req.app.locals.db, req.userId)) return next();
        return res.status(403).json({
            error: 'Only the first account created on this computer can change service settings.',
            code: 'SETTINGS_OWNER_ONLY'
        });
    } catch (err) { return next(err); }
};

const saveService = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        await settings.saveService(db, req.params.source, (req.body || {}).values);
        await afterChange(db, req.params.source);
        res.json({ services: settings.describe(true) });
    } catch (err) { sendSettingsError(res, err, next); }
};

const clearService = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        await settings.clearService(db, req.params.source);
        await afterChange(db, req.params.source);
        res.json({ services: settings.describe(true) });
    } catch (err) { sendSettingsError(res, err, next); }
};

module.exports = { listServices, requireOwner, saveService, clearService };
