// Loads configuration for both ways the server runs.
//
// Run from source: `.env` in the working directory first, as before.
// Always: `.env` in the data folder (services/paths.js; e.g. ~/Library/
// Application Support/Music Manager/.env), and when no JWT_SECRET is set
// anywhere, one is generated on first run and kept in `.jwt-secret` there
// (owner-only). So the app starts without any manual setup, installed or
// from a fresh copy of the source. Google / SoundCloud credentials can go in
// that `.env`, or be entered in the app (Settings -> Accounts).
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
    dotenv.config({ quiet: true }); // ./.env (run from source); never overrides real env vars
    // A test run configures itself (tests/setup.js) and stays out of real data.
    if (!isPackaged() && process.env.NODE_ENV === 'test') return;
    // The data folder's .env and generated JWT secret apply however the server
    // is started, so a fresh copy of the source runs with the same settings
    // and the same logins as the last one. Values already set win.
    const dir = dataDir();
    if (isPackaged()) ensureEnvTemplate(dir);
    dotenv.config({ path: path.join(dir, '.env'), quiet: true });
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = loadOrCreateJwtSecret(dir);
}

module.exports = { loadRuntimeConfig, loadOrCreateJwtSecret, ensureEnvTemplate, ENV_TEMPLATE };
