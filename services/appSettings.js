// Service credentials entered in the app (Settings -> Accounts).
//
// Connecting YouTube needs this installation's own Google OAuth client (and
// SoundCloud's library needs a SoundCloud app). Those used to live only in a
// .env file, which in an installed app sits in a hidden folder. They can now
// be typed into the app instead:
//   - stored in the app_settings table, encrypted like the service tokens;
//   - applied to process.env, so every existing reader keeps working and no
//     restart is needed;
//   - a value from the real environment / .env always wins and cannot be
//     changed from the app;
//   - only the installation's owner (the first account created on it) may
//     change them: they decide where every user's connect flow is sent.
// Secrets are write-only: nothing here hands a stored value back to a client.
const { encrypt, decrypt } = require('./tokenCrypto');

const MAX_VALUE_CHARS = 300;

// The only keys that can be set this way, grouped by the source they set up.
const SERVICES = {
    youtube: {
        label: 'YouTube',
        fields: [
            { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', secret: false },
            { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', secret: true }
        ],
        redirectUri: () => process.env.REDIRECT_URI || 'http://localhost:3000/auth/google/callback',
        help: 'In Google Cloud Console, enable "YouTube Data API v3", then create an OAuth client of type "Web application" and add the redirect address below to it.',
        helpUrl: 'https://console.cloud.google.com/apis/credentials'
    },
    soundcloud: {
        label: 'SoundCloud',
        fields: [
            { key: 'SOUNDCLOUD_CLIENT_ID', label: 'Client ID', secret: false },
            { key: 'SOUNDCLOUD_CLIENT_SECRET', label: 'Client secret', secret: true }
        ],
        redirectUri: () => process.env.SOUNDCLOUD_REDIRECT_URI || 'http://localhost:3000/auth/soundcloud/callback',
        help: 'Optional: search and playback work without it. A SoundCloud app (which needs an Artist Pro account) adds your likes and playlists. Register the redirect address below on the app.',
        helpUrl: 'https://soundcloud.com/you/apps'
    }
};

const ALL_KEYS = Object.values(SERVICES).flatMap((s) => s.fields.map((f) => f.key));

class SettingsError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'SettingsError';
        this.code = code;
        this.status = status;
    }
}

// Keys that had a value before any stored setting was applied: they come from
// the environment or a .env file and are not ours to change.
let fromEnv = null;
const envKeys = () => {
    if (!fromEnv) fromEnv = new Set(ALL_KEYS.filter((key) => process.env[key]));
    return fromEnv;
};

/** Applies the stored credentials to process.env. Call once, after initDB. */
async function applyStored(db) {
    const managed = envKeys();
    const rows = await db.all('SELECT key, value FROM app_settings');
    for (const row of rows || []) {
        if (!ALL_KEYS.includes(row.key) || managed.has(row.key)) continue;
        try {
            const value = decrypt(row.value);
            if (value) process.env[row.key] = value;
        } catch (err) {
            // A different encryption key than the one these were saved with.
            console.warn(`Stored setting ${row.key} could not be read (${err.message}); enter it again in Settings.`);
        }
    }
}

/** The owner is the first account created on this installation. */
async function ownerId(db) {
    const row = await db.get('SELECT MIN(id) AS id FROM users');
    return row && row.id !== null && row.id !== undefined ? Number(row.id) : null;
}

async function isOwner(db, userId) {
    return Number(userId) === (await ownerId(db));
}

/** What the Accounts screen shows for each service. Never includes a value. */
function describe(canEdit) {
    const managed = envKeys();
    return Object.entries(SERVICES).map(([source, service]) => {
        const fields = service.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, set: Boolean(process.env[f.key]) }));
        const inEnv = service.fields.some((f) => managed.has(f.key));
        const configured = fields.every((f) => f.set);
        return {
            source,
            label: service.label,
            fields,
            configured,
            // env: set in the environment / .env file; app: entered here.
            managedBy: inEnv ? 'env' : (fields.some((f) => f.set) ? 'app' : null),
            canEdit: Boolean(canEdit) && !inEnv,
            redirectUri: service.redirectUri(),
            help: service.help,
            helpUrl: service.helpUrl
        };
    });
}

function cleanValue(value, label) {
    if (typeof value !== 'string') throw new SettingsError('SETTINGS_BAD_VALUE', `${label} must be text.`);
    const text = value.trim();
    // eslint-disable-next-line no-control-regex
    if (!text || text.length > MAX_VALUE_CHARS || /[\s\u0000-\u001f\u007f]/.test(text)) {
        throw new SettingsError('SETTINGS_BAD_VALUE', `${label} is empty, too long, or contains spaces.`);
    }
    return text;
}

function serviceOrThrow(source) {
    const service = Object.prototype.hasOwnProperty.call(SERVICES, source) ? SERVICES[source] : null;
    if (!service) throw new SettingsError('SETTINGS_UNKNOWN_SERVICE', 'That service has no settings.', 404);
    if (service.fields.some((f) => envKeys().has(f.key))) {
        throw new SettingsError('SETTINGS_MANAGED_BY_ENV', `${service.label} is set up in the .env file; change it there.`, 409);
    }
    return service;
}

/** Saves a service's credentials (every field is required) and applies them. */
async function saveService(db, source, values) {
    const service = serviceOrThrow(source);
    const input = values && typeof values === 'object' ? values : {};
    const cleaned = service.fields.map((f) => [f.key, cleanValue(input[f.key], `${service.label} ${f.label.toLowerCase()}`)]);
    const now = Date.now();
    for (const [key, value] of cleaned) {
        await db.run(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, encrypt(value), now]
        );
        process.env[key] = value;
    }
}

/** Removes a service's stored credentials. */
async function clearService(db, source) {
    const service = serviceOrThrow(source);
    for (const f of service.fields) {
        await db.run('DELETE FROM app_settings WHERE key = ?', [f.key]);
        delete process.env[f.key];
    }
}

// Tests only.
function _resetForTests() { fromEnv = null; }

module.exports = { SettingsError, applyStored, ownerId, isOwner, describe, saveService, clearService, ALL_KEYS, _resetForTests };
