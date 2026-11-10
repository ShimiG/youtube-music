// Loads configuration for both ways the server runs.
//
// Development: `.env` in the working directory, as before.
// Packaged desktop app: there is no project folder, so `.env` is also read
// from the data folder (services/paths.js; e.g. ~/Library/Application
// Support/Music Manager/.env), and a JWT_SECRET is generated on first run and
// kept in `.jwt-secret` there (owner-only), so the app starts without any
// manual setup. Google / SoundCloud credentials still go in that `.env`.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { isPackaged, dataDir } = require('./paths');

function loadOrCreateJwtSecret(dir) {
    const file = path.join(dir, '.jwt-secret');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const secret = crypto.randomBytes(48).toString('hex');
    try {
        fs.writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
    } catch (err) {
        if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
        throw err;
    }
    console.log('Generated a JWT secret for this installation (.jwt-secret in the data folder).');
    return secret;
}

// Written once into the data folder of a packaged install, so the user finds
// where their own service credentials go. Credentials are never built into
// the app: the releases are public downloads.
const ENV_TEMPLATE = `# Music Manager settings for this computer.
# Fill in the values you need, save, and restart Music Manager.

# YouTube: an OAuth client from Google Cloud Console (YouTube Data API v3
# enabled). Authorized redirect URI: http://localhost:3000/auth/google/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# SoundCloud (optional; needs an app registered with an Artist Pro account).
# Without it, SoundCloud search and playback still work.
# Redirect URI: http://localhost:3000/auth/soundcloud/callback
SOUNDCLOUD_CLIENT_ID=
SOUNDCLOUD_CLIENT_SECRET=
`;

/** Creates the commented settings template if there is no .env yet. */
function ensureEnvTemplate(dir) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) return false;
    try {
        fs.writeFileSync(file, ENV_TEMPLATE, { mode: 0o600, flag: 'wx' });
        console.log(`Created a settings file for your service credentials: ${file}`);
        return true;
    } catch {
        return false; // another process created it, or the folder is read-only
    }
}

function loadRuntimeConfig() {
    dotenv.config({ quiet: true }); // ./.env (development); never overrides real env vars
    if (!isPackaged()) return;
    const dir = dataDir();
    ensureEnvTemplate(dir);
    dotenv.config({ path: path.join(dir, '.env'), quiet: true });
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = loadOrCreateJwtSecret(dir);
}

module.exports = { loadRuntimeConfig, loadOrCreateJwtSecret, ensureEnvTemplate, ENV_TEMPLATE };
