const path = require('path');
const { open } = require('./sqlite');
const { dataDir } = require('../services/paths');
const { migratePlaintextTokens } = require('../services/tokenCrypto');

// `filename` lets tests open ':memory:' or a temp file. The app always uses
// the default: the project folder in development, the per-user app-data
// folder when packaged (services/paths.js).
async function initDB(filename = path.join(dataDir(), 'database.sqlite')) {
    const db = await open(filename);

    // WAL lets reads happen concurrently with a write, and busy_timeout makes
    // callers wait for a locked DB instead of instantly failing with SQLITE_BUSY.
    await db.exec('PRAGMA journal_mode = WAL;');
    // With the write-ahead log, NORMAL cannot corrupt the database; at worst
    // the last moments before a power cut are lost. FULL (the default) syncs
    // the disk on every commit, which made each single write cost as much as
    // 33 batched ones (docs/performance-plan.md, step 4.1).
    await db.exec('PRAGMA synchronous = NORMAL;');
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

    await db.run(`INSERT OR IGNORE INTO sources (id, name) VALUES (1, 'youtube'), (2, 'spotify'), (3, 'soundcloud'), (4, 'audius'), (5, 'deezer'), (6, 'local')`);

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

    // Per-user display metadata. `tracks` is shared across users (UNIQUE per
    // source + external id), so the first writer used to decide the title and
    // thumbnail everyone saw. Each play / playlist entry now keeps its own
    // copy; the shared row is only a fallback for rows written before this.
    for (const table of ['history', 'playlist_tracks']) {
        const cols = (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
        for (const col of ['title', 'artist', 'thumbnail']) {
            if (!cols.includes(col)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
        }
    }

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

    // Local files (issue #24): folders a user added, and the audio files found
    // in them. Tracks are addressed by their row id, never by a path from the
    // client; rel_path is relative to the folder and re-checked on every play.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS local_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            path TEXT NOT NULL,                 -- real (resolved) absolute path
            added_at INTEGER NOT NULL,
            last_scan_at INTEGER,
            file_count INTEGER NOT NULL DEFAULT 0,
            scan_error TEXT,
            truncated INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, path)
        );
        CREATE TABLE IF NOT EXISTS local_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL,
            rel_path TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime_ms INTEGER NOT NULL,
            title TEXT NOT NULL,
            artist TEXT,
            album TEXT,
            track_no INTEGER,
            duration_sec INTEGER,
            format TEXT,
            FOREIGN KEY (folder_id) REFERENCES local_folders(id) ON DELETE CASCADE,
            UNIQUE(folder_id, rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_local_tracks_folder ON local_tracks(folder_id);
    `);

    // Lyrics found online (issue #30), kept so a track is looked up once. The
    // key is a hash of what was asked (title, artist, length), never a track
    // id from the client, so one user's request cannot change what another
    // sees. "Not found" is kept too, for a shorter time (services/lyrics.js).
    await db.exec(`
        CREATE TABLE IF NOT EXISTS lyrics_cache (
            lookup_key TEXT PRIMARY KEY,
            status TEXT NOT NULL,               -- found | instrumental | not_found
            synced TEXT,                        -- JSON [{ t, text }], or NULL
            plain TEXT,
            provider TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lyrics_cache_fetched ON lyrics_cache(fetched_at);
    `);

    // Dominant colour of cover images (issue #26), so each cover is downloaded
    // and read once. Keyed by a hash of the image URL; "none" marks an image
    // without colour (services/artworkColors.js).
    await db.exec(`
        CREATE TABLE IF NOT EXISTS artwork_colors (
            url_hash TEXT PRIMARY KEY,
            status TEXT NOT NULL,               -- ok | none
            color TEXT,                         -- #rrggbb when ok
            fetched_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artwork_colors_fetched ON artwork_colors(fetched_at);
    `);

    // Service credentials entered in the app (Settings -> Accounts), encrypted
    // like the tokens; see services/appSettings.js.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    // Cloud sync (docs/cloud-data.md, services/cloud/). A user links this
    // installation to a cloud account; from then on their custom playlists
    // and history are kept the same on every linked computer.
    //   app_meta      small installation-wide values (the cloud address, this
    //                 installation's device id). Nothing secret.
    //   cloud_links   one row per linked user: who they are in the cloud, the
    //                 session (encrypted like the service tokens), how far
    //                 this computer has read the cloud's changes.
    //   sync_records  the last state of every synced record that this
    //                 computer and the cloud agreed on, as a hash: what
    //                 differs from it locally has changed here.
    // playlists.sync_id is a playlist's id across computers (its row id is
    // only unique on one).
    await db.exec(`
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cloud_links (
            user_id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            session TEXT NOT NULL,
            session_expires_at INTEGER NOT NULL,
            cursor INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'ok',   -- ok | signin_required
            last_sync_at INTEGER,
            last_error TEXT,
            linked_at INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS sync_records (
            user_id INTEGER NOT NULL,
            collection TEXT NOT NULL,
            record_id TEXT NOT NULL,
            hash TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            dirty INTEGER NOT NULL DEFAULT 0,   -- 1: changed here, not yet sent
            PRIMARY KEY (user_id, collection, record_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    if (!(await db.all('PRAGMA table_info(playlists)')).some((c) => c.name === 'sync_id')) {
        await db.exec('ALTER TABLE playlists ADD COLUMN sync_id TEXT');
    }
    await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_sync_id ON playlists(sync_id) WHERE sync_id IS NOT NULL');
    // Whether the linked cloud account holds a YouTube connection (the last
    // answer from the cloud; services/cloud/google.js keeps it current).
    if (!(await db.all('PRAGMA table_info(cloud_links)')).some((c) => c.name === 'google_connected')) {
        await db.exec('ALTER TABLE cloud_links ADD COLUMN google_connected INTEGER NOT NULL DEFAULT 0');
    }

    // Tokens written before encryption at rest existed are rewritten encrypted.
    await migratePlaintextTokens(db);

    console.log('Database schemas initialized.');
    return db;
}

module.exports = initDB;
