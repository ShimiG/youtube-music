// Attaches a valid SoundCloud access token for the logged-in user as
// req.soundcloudToken, refreshing it server-side when it is about to expire.
// Must run AFTER requireAuth (needs req.userId). The client never sees the
// SoundCloud token; it only holds our own session JWT.
//
// Distinct `code` values let the client tell "never connected" apart from
// "connected but the session could not be renewed".
const { getUserToken } = require('../controllers/soundcloud/tokens');

module.exports = async (req, res, next) => {
    try {
        req.soundcloudToken = await getUserToken(req.app.locals.db, req.userId);
        next();
    } catch (err) {
        if (err.code === 'SOUNDCLOUD_NOT_CONNECTED') {
            return res.status(401).json({
                error: 'No SoundCloud account connected. Connect your account to continue.',
                code: err.code
            });
        }
        if (err.code === 'SOUNDCLOUD_TOKEN_EXPIRED') {
            return res.status(401).json({
                error: 'Your SoundCloud session has expired. Reconnect your account.',
                code: err.code
            });
        }
        next(err);
    }
};
