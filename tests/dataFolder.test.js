// Data lives in the per-user data folder however the server is started, and
// a database left in the project folder by an earlier version moves there
// once (services/paths.js, services/dataFolder.js, services/runtimeConfig.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ENV_KEYS = ['MUSIC_DATA_DIR', 'NODE_ENV', 'APPDATA', 'XDG_DATA_HOME', 'JWT_SECRET', 'GOOGLE_CLIENT_ID'];
let saved;
let tmp;
let homeSpy;
let log;

beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-datafolder-'));
    log = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    jest.resetModules();
});

afterEach(() => {
    if (homeSpy) homeSpy.mockRestore();
    homeSpy = null;
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    jest.dontMock('node:sea');
    jest.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
});

// The per-user folder for this platform, with the home folder pointed at `tmp`.
function fakeHome() {
    process.env.APPDATA = path.join(tmp, 'AppData');
    process.env.XDG_DATA_HOME = path.join(tmp, 'xdg');
    homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(tmp);
    if (process.platform === 'win32') return path.join(tmp, 'AppData', 'Music Manager');
    if (process.platform === 'darwin') return path.join(tmp, 'Library', 'Application Support', 'Music Manager');
    return path.join(tmp, 'xdg', 'music-manager');
}

function loadPaths({ packaged = false } = {}) {
    jest.doMock('node:sea', () => ({ isSea: () => packaged }), { virtual: true });
    return require('../services/paths');
}

// A project folder as an earlier version left it: a database in WAL mode with
// rows still in the -wal file, the token key, and a cache folder.
function oldProject() {
    const from = path.join(tmp, 'project');
    fs.mkdirSync(path.join(from, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(from, 'cache', 'youtube_aaaaaaaaaaa.mp3'), 'audio');
    fs.writeFileSync(path.join(from, '.token-key'), 'a'.repeat(64));
    const db = new DatabaseSync(path.join(from, 'database.sqlite'));
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);');
    db.prepare('INSERT INTO users (username) VALUES (?)').run('me');
    return { from, db };
}

const usersIn = (file) => {
    const db = new DatabaseSync(file);
    try { return db.prepare('SELECT username FROM users').all().map((r) => r.username); } finally { db.close(); }
};

describe('where the data lives', () => {
    it('is the per-user folder when run from source, as for the installed app', () => {
        delete process.env.MUSIC_DATA_DIR;
        process.env.NODE_ENV = 'development';
        const expected = fakeHome();
        const paths = loadPaths();
        expect(paths.usesUserDataDir()).toBe(true);
        expect(paths.dataDir()).toBe(expected);
        expect(fs.existsSync(expected)).toBe(true);
        expect(paths.dataDir()).not.toBe(paths.appRoot());
    });

    it('stays in the project folder for a test run, and MUSIC_DATA_DIR always wins', () => {
        delete process.env.MUSIC_DATA_DIR;
        process.env.NODE_ENV = 'test';
        let paths = loadPaths();
        expect(paths.usesUserDataDir()).toBe(false);
        expect(paths.dataDir()).toBe(paths.appRoot());

        jest.resetModules();
        process.env.NODE_ENV = 'development';
        process.env.MUSIC_DATA_DIR = path.join(tmp, 'chosen');
        paths = loadPaths();
        expect(paths.usesUserDataDir()).toBe(false);
        expect(paths.dataDir()).toBe(path.join(tmp, 'chosen'));
    });
});

describe('moving a project-folder database', () => {
    it('brings the database (with what was still in its write-ahead log), the key and the cache', () => {
        const { from, db } = oldProject();
        db.close();
        const to = path.join(tmp, 'data');
        fs.mkdirSync(to);
        const { moveProjectData } = require('../services/dataFolder');

        expect(moveProjectData({ from, to, log })).toEqual({ moved: true, from, to, key: true, cache: true });
        expect(usersIn(path.join(to, 'database.sqlite'))).toEqual(['me']);
        expect(fs.readFileSync(path.join(to, '.token-key'), 'utf8')).toBe('a'.repeat(64));
        if (process.platform !== 'win32') expect(fs.statSync(path.join(to, '.token-key')).mode & 0o777).toBe(0o600);
        expect(fs.existsSync(path.join(to, 'cache', 'youtube_aaaaaaaaaaa.mp3'))).toBe(true);

        // The old database is kept under another name, so nothing is lost and
        // the move is not attempted twice.
        expect(fs.existsSync(path.join(from, 'database.sqlite'))).toBe(false);
        expect(usersIn(path.join(from, 'database.sqlite.moved-to-data-folder'))).toEqual(['me']);
        expect(fs.existsSync(path.join(to, 'database.sqlite.incoming'))).toBe(false);
        expect(moveProjectData({ from, to, log })).toEqual({ moved: false, reason: 'nothing_to_move' });
        expect(log.log.mock.calls[0][0]).toMatch(/Moved your data from/);
    });

    it('never overwrites a database that is already in the data folder', () => {
        const { from, db } = oldProject();
        db.close();
        const to = path.join(tmp, 'data');
        fs.mkdirSync(to);
        const existing = new DatabaseSync(path.join(to, 'database.sqlite'));
        existing.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (username) VALUES ('installed-app');");
        existing.close();
        const { moveProjectData } = require('../services/dataFolder');

        expect(moveProjectData({ from, to, log })).toEqual({ moved: false, reason: 'data_folder_has_database' });
        expect(usersIn(path.join(to, 'database.sqlite'))).toEqual(['installed-app']);
        expect(usersIn(path.join(from, 'database.sqlite'))).toEqual(['me']); // left as it was
        expect(log.warn.mock.calls[0][0]).toMatch(/no longer used.*MUSIC_DATA_DIR=/);
    });

    it('keeps a token key that is already there, and copes without one', () => {
        const { from, db } = oldProject();
        db.close();
        const to = path.join(tmp, 'data');
        fs.mkdirSync(to);
        fs.writeFileSync(path.join(to, '.token-key'), 'b'.repeat(64));
        const { moveProjectData } = require('../services/dataFolder');
        expect(moveProjectData({ from, to, log })).toMatchObject({ moved: true, key: false });
        expect(fs.readFileSync(path.join(to, '.token-key'), 'utf8')).toBe('b'.repeat(64));
    });

    it('does nothing when there is nothing to move, or the folders are the same', () => {
        const { moveProjectData } = require('../services/dataFolder');
        const empty = path.join(tmp, 'empty');
        fs.mkdirSync(empty);
        expect(moveProjectData({ from: empty, to: path.join(tmp, 'data'), log })).toEqual({ moved: false, reason: 'nothing_to_move' });
        const { from, db } = oldProject();
        db.close();
        expect(moveProjectData({ from, to: from, log })).toEqual({ moved: false, reason: 'same_folder' });
        expect(fs.existsSync(path.join(from, 'database.sqlite'))).toBe(true);
    });

    it('leaves the old database in place and says what to do when the copy fails', () => {
        const { from, db } = oldProject();
        db.close();
        const { moveProjectData } = require('../services/dataFolder');
        // The "data folder" is a file, so nothing can be written into it.
        const blocked = path.join(tmp, 'not-a-folder');
        fs.writeFileSync(blocked, 'x');
        expect(moveProjectData({ from, to: blocked, log })).toEqual({ moved: false, reason: 'copy_failed' });
        expect(usersIn(path.join(from, 'database.sqlite'))).toEqual(['me']);
        expect(log.error.mock.calls[0][0]).toMatch(/MUSIC_DATA_DIR=/);
    });

    it('only runs by itself for a source run with the default folder', () => {
        process.env.NODE_ENV = 'test';
        delete process.env.MUSIC_DATA_DIR;
        loadPaths();
        expect(require('../services/dataFolder').moveProjectDataIfNeeded({ log })).toEqual({ moved: false, reason: 'not_applicable' });
        jest.resetModules();
        process.env.NODE_ENV = 'development';
        process.env.MUSIC_DATA_DIR = path.join(tmp, 'chosen');
        loadPaths();
        expect(require('../services/dataFolder').moveProjectDataIfNeeded({ log })).toEqual({ moved: false, reason: 'not_applicable' });
    });
});

describe('settings for a source run', () => {
    it('come from the data folder too, with a generated login secret, so a fresh copy needs no .env', () => {
        delete process.env.MUSIC_DATA_DIR;
        delete process.env.JWT_SECRET;
        delete process.env.GOOGLE_CLIENT_ID;
        process.env.NODE_ENV = 'development';
        const dir = fakeHome();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.env'), 'GOOGLE_CLIENT_ID=from-the-data-folder\n');
        jest.spyOn(console, 'log').mockImplementation(() => {});
        loadPaths();
        const config = require('../services/runtimeConfig');
        config.loadRuntimeConfig();
        console.log.mockRestore();

        expect(process.env.GOOGLE_CLIENT_ID).toBe('from-the-data-folder');
        const secret = process.env.JWT_SECRET;
        expect(secret).toMatch(/^[0-9a-f]{96}$/);
        expect(fs.readFileSync(path.join(dir, '.jwt-secret'), 'utf8').trim()).toBe(secret);
        // The same secret next time: logins survive a restart and a new copy.
        delete process.env.JWT_SECRET;
        config.loadRuntimeConfig();
        expect(process.env.JWT_SECRET).toBe(secret);
        // The template for credentials is only written for the installed app.
        expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('GOOGLE_CLIENT_ID=from-the-data-folder\n');
    });

    it('a test run is left alone', () => {
        process.env.NODE_ENV = 'test';
        delete process.env.MUSIC_DATA_DIR;
        const before = process.env.JWT_SECRET;
        loadPaths();
        require('../services/runtimeConfig').loadRuntimeConfig();
        expect(process.env.JWT_SECRET).toBe(before);
    });
});
