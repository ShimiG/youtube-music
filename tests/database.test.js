// Real-database tests for the node:sqlite adapter and config/db.js (the rest of
// the suite mostly uses database doubles). Each test gets its own data folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { open } = require('../config/sqlite');

let dir;
let previousDataDir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-db-'));
    previousDataDir = process.env.MUSIC_DATA_DIR;
    process.env.MUSIC_DATA_DIR = dir;
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    if (previousDataDir === undefined) delete process.env.MUSIC_DATA_DIR;
    else process.env.MUSIC_DATA_DIR = previousDataDir;
    console.log.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('node:sqlite adapter', () => {
    it('keeps the sqlite/sqlite3 API: get, all, run -> { lastID, changes }, exec', async () => {
        const db = await open(':memory:');
        await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b INTEGER)');
        const first = await db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['x', 1]);
        const second = await db.run('INSERT INTO t (a, b) VALUES (?, ?)', 'y', 2); // spread params too
        expect(first).toEqual({ lastID: 1, changes: 1 });
        expect(second.lastID).toBe(2);
        expect(await db.get('SELECT a FROM t WHERE id = ?', [2])).toEqual({ a: 'y' });
        expect(await db.get('SELECT a FROM t WHERE id = ?', [99])).toBeUndefined();
        expect(await db.all('SELECT id FROM t ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
        expect((await db.run('DELETE FROM t')).changes).toBe(2);
        await db.close();
    });

    it('binds undefined as NULL and booleans as 0/1, like sqlite3 did', async () => {
        const db = await open(':memory:');
        await db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
        await db.run('INSERT INTO t (a, b) VALUES (?, ?)', [undefined, true]);
        expect(await db.get('SELECT a, b FROM t')).toEqual({ a: null, b: 1 });
        await db.close();
    });

    it('returns plain objects, not null-prototype rows', async () => {
        const db = await open(':memory:');
        const row = await db.get('SELECT 1 AS one');
        expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
        await db.close();
    });
});

describe('initDB on a real file', () => {
    const initDB = () => require('../config/db')();

    it('creates the schema in MUSIC_DATA_DIR and enables WAL and foreign keys', async () => {
        const db = await initDB();
        expect(fs.existsSync(path.join(dir, 'database.sqlite'))).toBe(true);
        expect((await db.get('PRAGMA journal_mode')).journal_mode).toBe('wal');
        expect((await db.get('PRAGMA foreign_keys')).foreign_keys).toBe(1);
        const sources = await db.all('SELECT name FROM sources ORDER BY id');
        expect(sources.map((s) => s.name)).toEqual(['youtube', 'spotify', 'soundcloud', 'audius', 'deezer', 'local']);
        const historyCols = (await db.all('PRAGMA table_info(history)')).map((c) => c.name);
        expect(historyCols).toEqual(expect.arrayContaining(['title', 'artist', 'thumbnail']));
        await db.close();
    });

    it('upgrades a database created by an older version and encrypts its plaintext tokens', async () => {
        // The shape of database.sqlite before Stage 3, written with the old driver's schema.
        const old = await open(path.join(dir, 'database.sqlite'));
        await old.exec(`
            CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
            CREATE TABLE user_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, source_id INTEGER, access_token TEXT, refresh_token TEXT, UNIQUE(user_id, source_id));
            CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER, external_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT, thumbnail TEXT, UNIQUE(source_id, external_id));
            CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, track_id INTEGER, played_at DATETIME DEFAULT CURRENT_TIMESTAMP);
            INSERT INTO users (username, password) VALUES ('legacy', 'hash');
            INSERT INTO sources (id, name) VALUES (1, 'youtube');
            INSERT INTO user_connections (user_id, source_id, access_token, refresh_token) VALUES (1, 1, 'plain-access', 'plain-refresh');
            INSERT INTO tracks (source_id, external_id, title) VALUES (1, 'aaaaaaaaaaa', 'Old song');
            INSERT INTO history (user_id, track_id) VALUES (1, 1);
        `);
        await old.close();

        const db = await initDB();
        const conn = await db.get('SELECT access_token, refresh_token, expires_at FROM user_connections');
        expect(conn.access_token).toMatch(/^enc:v1:/);
        expect(conn.refresh_token).toMatch(/^enc:v1:/);
        expect(conn.expires_at).toBeNull();
        expect(require('../services/tokenCrypto').decrypt(conn.access_token)).toBe('plain-access');
        // Existing rows survive and the new per-user columns are added.
        const h = await db.get('SELECT title FROM history');
        expect(h.title).toBeNull();
        await db.close();
    });
});

describe('end to end on a real database', () => {
    let app;
    let db;

    beforeEach(async () => {
        app = require('../app');
        db = await require('../config/db')();
        app.locals.db = db;
    });

    afterEach(async () => { await db.close(); });

    it('register -> custom playlist -> add track -> per-user metadata in history', async () => {
        const reg = await request(app).post('/api/register').send({ username: 'alice', password: 'correct-horse-1' });
        expect(reg.statusCode).toBe(201);
        const auth = { Authorization: `Bearer ${reg.body.token}` };

        const login = await request(app).post('/api/login').send({ username: 'alice', password: 'correct-horse-1' });
        expect(login.statusCode).toBe(200);

        const pl = await request(app).post('/api/custom-playlists').set(auth).send({ name: 'Mix' });
        expect(pl.statusCode).toBe(201);

        const add = await request(app).post(`/api/custom-playlists/${pl.body.id}/tracks`).set(auth).send({
            sourceName: 'youtube', externalId: 'bbbbbbbbbbb', title: 'Song', artist: 'Band',
            thumbnail: 'https://i.ytimg.com/vi/bbbbbbbbbbb/default.jpg'
        });
        expect(add.statusCode).toBe(201);

        const tracks = await request(app).get(`/api/custom-playlists/${pl.body.id}/tracks`).set(auth);
        expect(tracks.body).toEqual([{
            id: 'bbbbbbbbbbb', title: 'Song', channelTitle: 'Band',
            image: 'https://i.ytimg.com/vi/bbbbbbbbbbb/default.jpg', source: 'youtube'
        }]);

        const lists = await request(app).get('/api/custom-playlists').set(auth);
        expect(lists.body[0]).toMatchObject({ name: 'Mix', itemCount: 1 });

        await request(app).post('/history').set(auth).send({ trackId: 'bbbbbbbbbbb', title: 'Song', artist: 'Band', source: 'youtube' });
        const hist = await request(app).get('/history').set(auth);
        expect(hist.body).toEqual([expect.objectContaining({ id: 'bbbbbbbbbbb', title: 'Song', source: 'youtube' })]);
    });

    it('rejects a duplicate username with 409', async () => {
        await request(app).post('/api/register').send({ username: 'bob', password: 'password-123' });
        const dup = await request(app).post('/api/register').send({ username: 'bob', password: 'password-456' });
        expect(dup.statusCode).toBe(409);
    });
});
