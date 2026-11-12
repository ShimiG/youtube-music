// One-time move of data that was created in the project folder.
//
// Run from source, the server used to keep its database in the project
// folder, so every fresh copy of the source started with no accounts, no
// playlists and no service credentials. Data now lives in the per-user data
// folder (services/paths.js). The first start after that change brings an
// existing project-folder database along:
//   - only when the data folder has no database yet (it is never overwritten);
//   - the database is copied (after folding its write-ahead log into it),
//     together with the key that encrypts the tokens stored in it;
//   - the audio cache is moved when it can be (it is only a cache);
//   - the old database is renamed, not deleted, so nothing is lost if this
//     goes wrong, and so the move is not attempted again.
const fs = require('fs');
const path = require('path');
const { appRoot, dataDir, usesUserDataDir, isPackaged } = require('./paths');

const DB_NAME = 'database.sqlite';
const KEY_NAME = '.token-key';
const MOVED_SUFFIX = '.moved-to-data-folder';

function checkpoint(dbPath) {
    // Fold the -wal file into the main file, so one file is the whole database.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
        db.close();
    }
}

/**
 * Moves the project folder's data to the data folder when that applies.
 * Returns what happened: { moved: true, from, to, key, cache } or
 * { moved: false, reason }.
 */
function moveProjectData({ from = appRoot(), to = dataDir(), log = console } = {}) {
    const oldDb = path.join(from, DB_NAME);
    const newDb = path.join(to, DB_NAME);
    if (path.resolve(from) === path.resolve(to)) return { moved: false, reason: 'same_folder' };
    if (!fs.existsSync(oldDb)) return { moved: false, reason: 'nothing_to_move' };
    if (fs.existsSync(newDb)) {
        log.warn(`The database in ${from} is no longer used: your data is in ${to}. To use the old one instead, start with MUSIC_DATA_DIR=${from}`);
        return { moved: false, reason: 'data_folder_has_database' };
    }

    try {
        checkpoint(oldDb);
        // Copy under another name first: a half-written file must never look
        // like a database.
        const incoming = `${newDb}.incoming`;
        fs.copyFileSync(oldDb, incoming);
        fs.renameSync(incoming, newDb);
    } catch (err) {
        log.error(`Could not move the database to ${to} (${err.message}). Start with MUSIC_DATA_DIR=${from} to keep using it where it is.`);
        return { moved: false, reason: 'copy_failed' };
    }

    // The key that decrypts the stored tokens belongs with the database.
    let key = false;
    const oldKey = path.join(from, KEY_NAME);
    const newKey = path.join(to, KEY_NAME);
    try {
        if (fs.existsSync(oldKey) && !fs.existsSync(newKey)) {
            fs.copyFileSync(oldKey, newKey);
            fs.chmodSync(newKey, 0o600);
            key = true;
        }
    } catch (err) {
        log.warn(`The token key could not be copied (${err.message}); connected services will need connecting again.`);
    }

    // The cache is rebuilt on demand; move it only when that is a rename.
    let cache = false;
    try {
        const oldCache = path.join(from, 'cache');
        const newCache = path.join(to, 'cache');
        if (fs.existsSync(oldCache) && !fs.existsSync(newCache)) {
            fs.renameSync(oldCache, newCache);
            cache = true;
        }
    } catch { /* another disk: the cache simply starts empty */ }

    try {
        fs.renameSync(oldDb, `${oldDb}${MOVED_SUFFIX}`);
        for (const side of ['-wal', '-shm']) fs.rmSync(`${oldDb}${side}`, { force: true });
    } catch (err) {
        log.warn(`The old database could not be renamed (${err.message}); it is no longer used.`);
    }
    log.log(`Moved your data from ${from} to ${to}. The old database is kept as ${DB_NAME}${MOVED_SUFFIX}.`);
    return { moved: true, from, to, key, cache };
}

/** Runs the move when the server was started from source with the default data folder. */
function moveProjectDataIfNeeded(options) {
    if (isPackaged() || !usesUserDataDir()) return { moved: false, reason: 'not_applicable' };
    return moveProjectData(options);
}

module.exports = { moveProjectData, moveProjectDataIfNeeded, MOVED_SUFFIX };
