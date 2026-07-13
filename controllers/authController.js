const { google } = require('googleapis');
const jwt = require('jsonwebtoken');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim();

const SOURCE_YOUTUBE = 1;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Returns the Google consent URL for the logged-in user (requireAuth runs first).
// The callback arrives as a bare browser redirect with no Authorization header,
// so we carry the userId across in `state` — a short-lived signed token Google
// echoes back to us untouched.
const getGoogleAuthUrl = (req, res) => {
    const state = jwt.sign(
        { userId: req.userId, purpose: 'google_oauth' },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
    );

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [
            'https://www.googleapis.com/auth/youtube.readonly',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email'
        ],
        state
    });

    res.json({ url });
};

const googleCallback = async (req, res, next) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('No authorization code received');
    if (!state) return res.status(400).send('Missing state. Start the connect flow from the app.');

    let userId;
    try {
        const payload = jwt.verify(state, process.env.JWT_SECRET);
        if (payload.purpose !== 'google_oauth') throw new Error('wrong token purpose');
        userId = payload.userId;
    } catch {
        return res.status(400).send('Invalid or expired state. Start the connect flow again from the app.');
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens || !tokens.access_token) {
            return res.redirect(`${CLIENT_ORIGIN}/#google=error`);
        }

        // Google access tokens live ~1 hour; expiry_date is a ms epoch.
        const expiresAt = tokens.expiry_date || Date.now() + 3500 * 1000;

        // Keep the previous refresh_token if Google omits one — it is only
        // guaranteed on the first consent (prompt:'consent' forces it, but
        // COALESCE keeps us safe if that ever changes).
        await req.app.locals.db.run(
            `INSERT INTO user_connections (user_id, source_id, access_token, refresh_token, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id, source_id) DO UPDATE SET
                access_token = excluded.access_token,
                refresh_token = COALESCE(excluded.refresh_token, user_connections.refresh_token),
                expires_at = excluded.expires_at`,
            [userId, SOURCE_YOUTUBE, tokens.access_token, tokens.refresh_token || null, expiresAt]
        );

        // Tokens stay server-side; the client only learns the expiry time (via
        // the URL fragment, which never reaches a server or its logs).
        res.redirect(`${CLIENT_ORIGIN}/#google=connected&expires_at=${expiresAt}`);
    } catch (error) {
        console.error('Error retrieving access token:', error.message);
        res.redirect(`${CLIENT_ORIGIN}/#google=error`);
    }
};

// Lists which streaming services the logged-in user has connected, with each
// token's expiry so the client can schedule its auto-logout.
const getConnections = async (req, res, next) => {
    try {
        const rows = await req.app.locals.db.all(
            `SELECT s.name AS source_name, uc.expires_at
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

module.exports = { getGoogleAuthUrl, googleCallback, getConnections };
