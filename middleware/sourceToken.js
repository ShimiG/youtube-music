// sourceToken(source): attaches a valid access token for the logged-in user's
// connection to `source` as req.sourceToken, refreshing it server-side when it
// is about to expire. Must run AFTER requireAuth (needs req.userId). The client
// never sees service tokens; it only holds our own session JWT.
//
// Failures use the unified codes from services/errors.js, with the source name,
// so the client has one handler for every service:
//   401 SOURCE_NOT_CONNECTED  { source }
//   401 SOURCE_TOKEN_EXPIRED  { source }  (refresh failed; reconnect)
const { getSourceToken } = require('../services/connections');
const { SourceError } = require('../services/errors');

module.exports = (source) => async (req, res, next) => {
    try {
        req.sourceToken = await getSourceToken(req.app.locals.db, req.userId, source);
        next();
    } catch (err) {
        if (err instanceof SourceError) {
            return res.status(err.status).json({ error: err.message, code: err.code, source: err.source });
        }
        next(err);
    }
};
