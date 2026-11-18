#!/usr/bin/env node
// Hands a service credential this computer has to another program, without
// showing it: for moving the credentials into the cloud service.
//
// Credentials entered in the app (Settings -> Accounts) are kept in the
// database, encrypted with this computer's key; ones in a .env file are kept
// there. This reads them the way the server does (a .env value wins) and
// writes the value to its output, to be piped straight into the next
// program, for example into the Worker's secrets (cloud/README.md):
//
//   node scripts/copy-secret.js GOOGLE_CLIENT_SECRET | (cd cloud && npx wrangler secret put GOOGLE_CLIENT_SECRET)
//
// It refuses to print a secret to the terminal, where it would end up on the
// screen and in the scroll-back. `--list` says which credentials there are
// and where each comes from, never the values.
//
// The data folder is the one the server uses (MUSIC_DATA_DIR when set). The
// database is opened read-only; the app may keep running.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../services/runtimeConfig').loadRuntimeConfig();
const { dataDir } = require('../services/paths');
const { decrypt } = require('../services/tokenCrypto');

// What can be copied, and whether it is a secret (a client ID is not: it is
// shown in every sign-in address).
const KEYS = {
    GOOGLE_CLIENT_ID: false,
    GOOGLE_CLIENT_SECRET: true,
    SOUNDCLOUD_CLIENT_ID: false,
    SOUNDCLOUD_CLIENT_SECRET: true,
    AUDIUS_API_KEY: false
};

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

/** The value of `key` from the database, or null. */
function stored(key) {
    const file = path.join(dataDir(), 'database.sqlite');
    if (!fs.existsSync(file)) return null;
    let db;
    try {
        db = new DatabaseSync(file, { readOnly: true });
        const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
        return row ? decrypt(row.value) || null : null;
    } catch {
        return null; // no such table (an old database), or another key
    } finally {
        if (db) db.close();
    }
}

/** { value, from } for `key`, or null. */
function find(key) {
    if (process.env[key]) return { value: process.env[key], from: 'the .env file or the environment' };
    const value = stored(key);
    return value ? { value, from: 'the app (Settings, Accounts)' } : null;
}

function main() {
    const [arg] = process.argv.slice(2);
    if (!arg || arg === '--help' || arg === '-h') {
        process.stderr.write(`Usage:\n  node scripts/copy-secret.js --list\n  node scripts/copy-secret.js <NAME> | <program that reads it>\n\nNAME is one of: ${Object.keys(KEYS).join(', ')}\nData folder: ${dataDir()}\n`);
        process.exit(arg ? 0 : 1);
    }
    if (arg === '--list') {
        process.stderr.write(`Data folder: ${dataDir()}\n`);
        for (const key of Object.keys(KEYS)) {
            const found = find(key);
            process.stdout.write(`${key.padEnd(26)} ${found ? `set, in ${found.from}` : 'not set here'}\n`);
        }
        return;
    }
    if (!Object.prototype.hasOwnProperty.call(KEYS, arg)) fail(`Unknown name "${arg}". One of: ${Object.keys(KEYS).join(', ')}`);
    const found = find(arg);
    if (!found) fail(`${arg} is not set on this computer (data folder: ${dataDir()}).`);
    if (KEYS[arg] && process.stdout.isTTY) {
        fail(`Not printing ${arg} on the screen. Pipe it into the program that needs it, for example:\n  node scripts/copy-secret.js ${arg} | (cd cloud && npx wrangler secret put ${arg})`);
    }
    // No newline into another program: it stores exactly what it is given.
    process.stdout.write(process.stdout.isTTY ? `${found.value}\n` : found.value);
    process.stderr.write(`${arg}: handed over (from ${found.from}).\n`);
}

main();
