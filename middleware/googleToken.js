// Loads the logged-in user's stored Google access token from user_connections
// and attaches it as req.oauthToken for the YouTube-backed endpoints. Must run
// AFTER requireAuth (it relies on req.userId). The client never holds the
// Google token itself — it only holds our own session JWT.
//
// Distinct `code` values let the client tell "never connected" apart from
// "connected but expired" and show the right prompt.
const SOURCE_YOUTUBE = 1;

// Refuse tokens about to expire, so a request does not die mid-flight at Google.
const EXPIRY_SKEW_MS = 30 * 1000;

module.exports = async (req, res, next) => {
    try {
        const row = await req.app.locals.db.get(
            `SELECT access_token, expires_at FROM user_connections WHERE user_id = ? AND source_id = ?`,
            [req.userId, SOURCE_YOUTUBE]
        );

        if (!row || !row.access_token) {
            return res.status(401).json({
                error: 'No YouTube account connected. Connect your account to continue.',
                code: 'GOOGLE_NOT_CONNECTED'
            });
        }

        if (row.expires_at && row.expires_at <= Date.now() + EXPIRY_SKEW_MS) {
            return res.status(401).json({
                error: 'Your YouTube session has expired. Reconnect your account.',
                code: 'GOOGLE_TOKEN_EXPIRED'
            });
        }

        req.oauthToken = row.access_token;
        next();
    } catch (err) {
        next(err);
    }
};
