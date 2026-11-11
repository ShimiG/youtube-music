// Only the YouTube client and Google's auth library, not all of `googleapis`
// (which is ~30 MB of every Google API and dominated the packaged executable).
const { auth } = require('@googleapis/youtube');
const jwt = require('jsonwebtoken');

const connections = require('../services/connections');
const { SOURCE_IDS, storeConnection } = connections;
const { parseReturnTarget, finishOAuth } = require('../services/oauthReturn');

const DEFAULT_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const REVOKE_TIMEOUT_MS = 5000;

// Read on every use, not once at start: the credentials can be entered in the
// app while it runs (Settings -> Accounts, services/appSettings.js).
const isConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const oauthClient = () => new auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || DEFAULT_REDIRECT_URI
);

// Returns the Google consent URL for the logged-in user (requireAuth runs first).
// The callback arrives as a bare browser redirect with no Authorization header,
// so we carry the userId across in `state` — a short-lived signed token Google
// echoes back to us untouched.
const getGoogleAuthUrl = (req, res) => {
    if (!isConfigured()) {
        return res.status(503).json({
            error: 'YouTube is not set up on this computer yet. Add its Google credentials under Settings, Accounts.',
            code: 'SOURCE_NOT_CONFIGURED',
            source: 'youtube'
        });
    }
    const state = jwt.sign(
        // ret: where the flow ends (web client or the desktop app's deep link);
        // signed, so the callback cannot be pointed anywhere else.
        { userId: req.userId, purpose: 'google_oauth', ret: parseReturnTarget(req.query.return) },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
    );

    // Read-only by default so most users keep the smaller consent. The `youtube`
    // write scope (needed to like/unlike) is requested only when the client asks
    // for it, which it does the first time the user taps like and the API
    // answers SOURCE_SCOPE_REQUIRED.
    const scope = [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email'
    ];
    if (req.query.scope === 'write') scope.push('https://www.googleapis.com/auth/youtube');

    const url = oauthClient().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope,
        state
    });

    res.json({ url });
};

const googleCallback = async (req, res, next) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('No authorization code received');
    if (!state) return res.status(400).send('Missing state. Start the connect flow from the app.');

    let userId;
    let ret = 'web';
    try {
        const payload = jwt.verify(state, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        if (payload.purpose !== 'google_oauth') throw new Error('wrong token purpose');
        userId = payload.userId;
        ret = parseReturnTarget(payload.ret);
    } catch {
        return res.status(400).send('Invalid or expired state. Start the connect flow again from the app.');
    }

    // Two separate failure modes, logged distinctly: the exchange with Google,
    // and storing the result. A single catch used to label both "Error
    // retrieving access token", which hid database errors behind the wrong cause.
    let tokens;
    try {
        ({ tokens } = await oauthClient().getToken(code));
    } catch (error) {
        console.error('Google token exchange failed:', error.message);
        return finishOAuth(res, ret, `google=error&reason=token_exchange`);
    }

    if (!tokens || !tokens.access_token) {
        return finishOAuth(res, ret, `google=error&reason=no_access_token`);
    }

    const db = req.app.locals.db;
    try {
        // The session JWT only proves a signature; the account it names may have
        // been deleted since, or created against a different copy of the
        // database. user_connections.user_id has a FOREIGN KEY to users(id), so
        // check first and give a clear reason instead of a constraint error.
        const user = await db.get(`SELECT id FROM users WHERE id = ?`, [userId]);
        if (!user) {
            console.error(`Google connect: user ${userId} from the state token no longer exists; the client is holding a stale session. Log out and in again.`);
            return finishOAuth(res, ret, `google=error&reason=user_not_found`);
        }

        // Google access tokens live ~1 hour; expiry_date is a ms epoch.
        const expiresAt = tokens.expiry_date || Date.now() + 3500 * 1000;

        // Encrypted at rest. A missing refresh_token keeps the stored one (it
        // is only guaranteed on the first consent; prompt:'consent' forces it).
        await storeConnection(db, userId, 'youtube', {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || null,
            expiresAt
        });
        const stored = await db.get(
            `SELECT refresh_token FROM user_connections WHERE user_id = ? AND source_id = ?`,
            [userId, SOURCE_IDS.youtube]
        );
        const refreshable = stored && stored.refresh_token ? 1 : 0;

        // Tokens stay server-side; the client only learns the expiry and whether
        // the server renews it on its own (via the URL fragment, which never
        // reaches a server or its logs). A refreshable connection does not
        // trigger the client's auto-logout.
        finishOAuth(res, ret, `google=connected&expires_at=${expiresAt}&refreshable=${refreshable}`);
    } catch (error) {
        console.error('Failed to store Google tokens:', error.message);
        finishOAuth(res, ret, `google=error&reason=store_failed`);
    }
};

// Lists which streaming services the logged-in user has connected, with each
// token's expiry so the client can schedule its auto-logout. `refreshable`
// marks connections the server renews itself (any source with a stored
// refresh token): their expiry passing does not mean the user has to reconnect.
const getConnections = async (req, res, next) => {
    try {
        const rows = await req.app.locals.db.all(
            `SELECT s.name AS source_name, uc.expires_at,
                    CASE WHEN s.name IN ('youtube', 'soundcloud') AND uc.refresh_token IS NOT NULL THEN 1 ELSE 0 END AS refreshable
             FROM user_connections uc
             JOIN sources s ON uc.source_id = s.id
             WHERE uc.user_id = ?`,
            [req.userId]
        );
        res.json(rows);
    } catch (err) {
        next(err);
    }
};

// Disconnects the user's YouTube account: the stored tokens are deleted, and
// Google is asked (best effort) to revoke the grant so the tokens are dead
// there too. Revoking either token revokes the whole grant.
const disconnectGoogle = async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        let stored = null;
        try {
            stored = await connections.getConnection(db, req.userId, 'youtube');
        } catch { /* undecryptable: nothing to revoke, the row is still removed */ }
        await db.run(`DELETE FROM user_connections WHERE user_id = ? AND source_id = ?`, [req.userId, SOURCE_IDS.youtube]);
        const token = stored && (stored.refreshToken || stored.accessToken);
        if (token) {
            try {
                await connections.http.fetch(GOOGLE_REVOKE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token }),
                    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS)
                });
            } catch { /* offline, or already revoked: the local copy is gone either way */ }
        }
        res.status(204).end();
    } catch (err) {
        next(err);
    }
};

module.exports = { getGoogleAuthUrl, googleCallback, getConnections, disconnectGoogle };
