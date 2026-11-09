const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const dbPath = path.resolve(__dirname, '../database.sqlite');

// `filename` lets tests open ':memory:'; the app always uses the default file.
async function initDB(filename = dbPath) {
    const db = await open({
        filename,
        driver: sqlite3.Database
    });

    // WAL lets reads happen concurrently with a write, and busy_timeout makes
    // callers wait for a locked DB instead of instantly failing with SQLITE_BUSY.
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA busy_timeout = 5000;');
    await db.exec('PRAGMA foreign_keys = ON;');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, source_id INTEGER,
            access_token TEXT, refresh_token TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
            UNIQUE(user_id, source_id)
        );
    `);

    await db.run(`INSERT OR IGNORE INTO sources (id, name) VALUES (1, 'youtube'), (2, 'spotify'), (3, 'soundcloud')`);

    // App-level (client_credentials) tokens, one row per provider. SoundCloud
    // rate-limits new client_credentials tokens, so the token survives restarts
    // here and is renewed with its refresh_token instead of re-requested.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS app_tokens (
            provider TEXT PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at INTEGER NOT NULL
        );
    `);

    // Databases created before token expiry tracking lack this column; add it
    // in place. expires_at is a millisecond epoch (googleapis' expiry_date).
    const connectionColumns = await db.all(`PRAGMA table_info(user_connections)`);
    if (!connectionColumns.some((col) => col.name === 'expires_at')) {
        await db.exec(`ALTER TABLE user_connections ADD COLUMN expires_at INTEGER`);
    }

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, external_id TEXT NOT NULL,
            title TEXT NOT NULL, artist TEXT, thumbnail TEXT,
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
            UNIQUE(source_id, external_id)
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            thumbnail TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS playlist_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER, track_id INTEGER, sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
            FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            track_id INTEGER,
            played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
        );
    `);

    // Indexes on the columns we filter and join on. Without these, SQLite scans
    // the whole table for every playlist/history lookup.
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);
        CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, played_at DESC);
    `);

    // Match-mode sources (Spotify first) play through a YouTube video chosen
    // by services/matcher. The decision is kept per (source, track) so a
    // playlist page never re-searches, and override_by records that a person
    // picked the video, which automatic resolution must never undo. The isrc
    // index lets a recording already matched for one track be reused for the
    // same recording under another id or source.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS track_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            external_id TEXT NOT NULL,
            isrc TEXT,
            status TEXT NOT NULL,              -- matched | not_found | error
            video_id TEXT,                     -- 11-char YouTube id when matched
            score INTEGER,
            method TEXT,                       -- ytmusic | ytsearch | isrc | manual
            candidates_json TEXT,              -- up to 5 evaluated candidates (JSON)
            checked_at INTEGER NOT NULL,       -- ms epoch of the last resolution
            override_by INTEGER,               -- users.id when a person chose the match
            duration_sec INTEGER,              -- length of the matched video, for ISRC reuse
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
            UNIQUE(source_id, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_track_matches_isrc ON track_matches(isrc);
        CREATE TABLE IF NOT EXISTS match_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            source_id INTEGER NOT NULL,
            external_id TEXT NOT NULL,
            reason TEXT NOT NULL,              -- wrong_match | unavailable | other
            video_id TEXT,                     -- the user's suggested replacement, if any
            note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
        );
    `);

    // Match tables created before ISRC reuse checked durations lack this
    // column; add it in place like user_connections.expires_at above.
    const matchColumns = await db.all(`PRAGMA table_info(track_matches)`);
    if (!matchColumns.some((col) => col.name === 'duration_sec')) {
        await db.exec(`ALTER TABLE track_matches ADD COLUMN duration_sec INTEGER`);
    }

    console.log('Database schemas initialized.');
    return db;
}

module.exports = initDB;
