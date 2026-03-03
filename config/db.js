const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const dbPath = path.resolve(__dirname, '../database.sqlite');

async function initDB() {
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    console.log('Connected to SQLite database.');
    await db.exec(`
        -- 1. USERS TABLE
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            oauth_id TEXT UNIQUE NOT NULL,
            display_name TEXT,
            email TEXT,
            platform TEXT, -- e.g., 'google' or 'spotify'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 2. PLAYLISTS TABLE
        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT NOT NULL,
            thumbnail TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- 3. PLAYLIST_TRACKS TABLE (Junction Table)
        CREATE TABLE IF NOT EXISTS playlist_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER,
            track_id TEXT NOT NULL, -- The YouTube or Spotify ID
            title TEXT NOT NULL,
            artist TEXT,
            thumbnail TEXT,
            duration TEXT,
            added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        );

        -- 4. HISTORY TABLE
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            track_id TEXT NOT NULL,
            title TEXT NOT NULL,
            artist TEXT,
            thumbnail TEXT, 
            played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    console.log(' Database schemas initialized.');
    return db;
}

module.exports = initDB;