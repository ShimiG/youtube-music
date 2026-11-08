// Encryption at rest for OAuth tokens (ROADMAP Stage 3, security).
//
// Access and refresh tokens in `user_connections` and `app_tokens` are stored
// as `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, base64url parts), so a
// copied, backed-up or accidentally committed database.sqlite does not hand
// out working Google / SoundCloud sessions.
//
// Key source, in order:
//   1. TOKEN_ENCRYPTION_KEY: 32 bytes as 64 hex chars or base64. This is the
//      hook for the desktop shell: Tauri can read the key from the OS keychain
//      and pass it to the server sidecar in its environment.
//   2. A key file (TOKEN_KEY_FILE, default `.token-key` next to the database),
//      generated on first run with owner-only permissions. This protects the
//      database file on its own; it does not protect against someone who can
//      read the whole app directory.
//
// Values without the prefix are legacy plaintext: decrypt() returns them as is
// and migratePlaintextTokens() rewrites them encrypted at startup.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const DEFAULT_KEY_FILE = path.resolve(__dirname, '../.token-key');

let cachedKey = null;

function parseKey(raw) {
    const value = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    const b64 = Buffer.from(value, 'base64');
    if (b64.length === 32) return b64;
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64');
}

function loadOrCreateKeyFile(file) {
    if (fs.existsSync(file)) return parseKey(fs.readFileSync(file, 'utf8'));
    const key = crypto.randomBytes(32);
    // wx: never overwrite a key another process just wrote; 0600: owner only.
    try {
        fs.writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
        if (err.code === 'EEXIST') return parseKey(fs.readFileSync(file, 'utf8'));
        throw err;
    }
    console.warn(`Token encryption: generated a new key at ${path.basename(file)}. Set TOKEN_ENCRYPTION_KEY to manage it yourself.`);
    return key;
}

function getKey() {
    if (cachedKey) return cachedKey;
    cachedKey = process.env.TOKEN_ENCRYPTION_KEY
        ? parseKey(process.env.TOKEN_ENCRYPTION_KEY)
        : loadOrCreateKeyFile(process.env.TOKEN_KEY_FILE || DEFAULT_KEY_FILE);
    return cachedKey;
}

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/** Encrypts a token. null/undefined pass through so optional columns stay NULL. */
function encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    if (isEncrypted(plaintext)) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + [iv, tag, ciphertext].map((b) => b.toString('base64url')).join(':');
}

/**
 * Decrypts a stored token. Legacy plaintext is returned unchanged. A value that
 * fails authentication (wrong key, tampering) returns null, so callers treat
 * the connection as missing and ask the user to reconnect instead of crashing.
 */
function decrypt(stored) {
    if (stored === null || stored === undefined) return stored;
    if (!isEncrypted(stored)) return stored;
    try {
        const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'));
        const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        console.error('Token decryption failed (wrong TOKEN_ENCRYPTION_KEY or tampered value); treating the connection as disconnected.');
        return null;
    }
}

/** Encrypts any plaintext tokens left from before encryption existed. */
async function migratePlaintextTokens(db) {
    let migrated = 0;
    const tables = [
        { table: 'user_connections', key: 'id' },
        { table: 'app_tokens', key: 'provider' }
    ];
    for (const { table, key } of tables) {
        const rows = await db.all(`SELECT ${key} AS k, access_token, refresh_token FROM ${table}`);
        for (const row of rows) {
            const needs = [row.access_token, row.refresh_token].some((v) => v && !isEncrypted(v));
            if (!needs) continue;
            await db.run(
                `UPDATE ${table} SET access_token = ?, refresh_token = ? WHERE ${key} = ?`,
                [encrypt(row.access_token), encrypt(row.refresh_token), row.k]
            );
            migrated++;
        }
    }
    if (migrated) console.log(`Token encryption: encrypted ${migrated} stored token row(s).`);
    return migrated;
}

// Tests only.
function _resetKey() { cachedKey = null; }

module.exports = { encrypt, decrypt, isEncrypted, migratePlaintextTokens, _resetKey };
