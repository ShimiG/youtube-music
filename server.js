require('dotenv').config();

const app = require('./app');
const initDB = require('./config/db');
const { updateYtDlp } = require('./services/ytdlp');
const { prepareCache } = require('./controllers/transcode');
const { encrypt } = require('./services/tokenCrypto');

const PORT = process.env.PORT || 3000;
// A desktop app's API must not be reachable from the LAN: bind to loopback
// unless HOST says otherwise (e.g. HOST=0.0.0.0 inside a container).
const HOST = process.env.HOST || '127.0.0.1';

// Fail fast if a required secret is missing, instead of crashing later on the
// first request that needs it.
function validateEnv() {
    const missing = [];
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
        console.warn('Warning: JWT_SECRET is short; use at least 32 random characters.');
    }
    if (!process.env.SOUNDCLOUD_CLIENT_ID || !process.env.SOUNDCLOUD_CLIENT_SECRET) {
        console.warn('SoundCloud: no API credentials (SOUNDCLOUD_CLIENT_ID / SECRET). Search and playback run through yt-dlp; connecting an account and the library need the official API.');
    }
    // Load (or create) the token encryption key now, so a malformed
    // TOKEN_ENCRYPTION_KEY stops the server at boot, not at the first connect.
    try {
        encrypt('startup-check');
    } catch (err) {
        console.error(`Token encryption key error: ${err.message}`);
        process.exit(1);
    }
    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        console.error('Copy .env.example to .env and fill in the values.');
        process.exit(1);
    }
}

validateEnv();

initDB()
    .then((db) => {
        app.locals.db = db;
        app.listen(PORT, HOST, () => {
            console.log(`Server running on http://${HOST}:${PORT}`);
            // Remove stale .part files, migrate legacy cache names, apply the size cap.
            prepareCache().catch((err) => console.warn('Cache housekeeping failed:', err.message));
            // Best-effort, in the background: a stale yt-dlp is the usual reason
            // YouTube or SoundCloud playback stops working.
            updateYtDlp();
        });
    })
    .catch((err) => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    });
