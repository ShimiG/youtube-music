const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const dbPath = path.resolve(__dirname, '../database.sqlite');

async function initDB() {
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

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

    await db.run(`INSERT OR IGNORE INTO sources (id, name) VALUES (1, 'youtube'), (2, 'spotify')`);
    
    await db.exec(`
        -- Users table with support for local and OAuth authentication
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password TEXT,
            auth_provider TEXT DEFAULT 'local',
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

    console.log('Database schemas initialized.');
    return db;
}

module.exports = initDB;