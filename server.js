// .env from the working directory; when packaged, also from the data folder,
// plus a generated JWT_SECRET (services/runtimeConfig.js). Must run first.
require('./services/runtimeConfig').loadRuntimeConfig();
// From here on, everything printed also goes to logs/server.log in the data
// folder, so a problem can be looked at after the window is closed.
if (require('./services/logFile').install()) {
    console.log(`---- Music Manager ${require('./package.json').version} starting (Node ${process.version}, ${process.platform} ${process.arch}) ----`);
}
// Data created in the project folder by an earlier version moves to the
// per-user data folder once (services/dataFolder.js). Before anything opens
// the database.
require('./services/dataFolder').moveProjectDataIfNeeded();

const app = require('./app');
const initDB = require('./config/db');
const { updateYtDlpIfDue } = require('./services/ytdlp');

// How long after start-up the housekeeping that can wait begins.
const BACKGROUND_START_DELAY_MS = 45 * 1000;
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
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        const where = require('path').join(require('./services/paths').dataDir(), '.env');
        console.warn(`YouTube: no Google OAuth credentials in the environment. Enter them in the app (Settings, Accounts) or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in ${where}.`);
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
    .then(async (db) => {
        app.locals.db = db;
        // Service credentials entered in the app (Settings -> Accounts).
        await require('./services/appSettings').applyStored(db);
        app.listen(PORT, HOST, () => {
            console.log(`Server running on http://${HOST}:${PORT}`);
            console.log(`Data folder: ${require('./services/paths').dataDir()}`);
            // Which helper binaries this run uses: the first thing to check when
            // nothing plays (also in GET /api/health, with their versions).
            console.log(`Using yt-dlp: ${require('./services/ytdlp').ytDlpPath}`);
            console.log(`Using ffmpeg: ${require('./services/paths').resolveFfmpeg()}`);
            // Remove stale .part files, migrate legacy cache names, apply the size cap.
            prepareCache().catch((err) => console.warn('Cache housekeeping failed:', err.message));
            // Keep linked users' playlists and history in step with the cloud.
            require('./services/cloud/sync').start(db)
                .catch((err) => console.warn('Cloud sync could not start:', err.message));
            // Not at once: these compete with the first clicks for the disk
            // and the processor (docs/performance-plan.md, step 3.2).
            const later = setTimeout(() => {
                // Pick up music added or removed in local folders while the app was closed.
                require('./services/localLibrary').rescanAll(db)
                    .catch((err) => console.warn('Local files: rescan after startup failed:', err.message));
                // Best-effort: a stale yt-dlp is the usual reason YouTube or
                // SoundCloud playback stops working. Looked for once a day.
                updateYtDlpIfDue();
            }, BACKGROUND_START_DELAY_MS);
            later.unref();
        });
    })
    .catch((err) => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    });
