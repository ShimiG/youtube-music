// Local files (issue #24) against real folders and a real database in a temp
// directory. Tag reading (music-metadata, ESM-only, which Jest cannot load) is
// stubbed through tagReader.runner; everything else is real: the walk,
// symlinks, the containment check, HTTP range responses.
const mockStreamTranscoded = jest.fn();
jest.mock('../controllers/transcode', () => ({
    ...jest.requireActual('../controllers/transcode'),
    streamTranscoded: (...args) => mockStreamTranscoded(...args)
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { withMedia } = require('./helpers/media');

// The product resolves paths with fs.promises.realpath (the native call). On
// Windows that expands short names such as RUNNER~1, which plain
// fs.realpathSync does not, so the tests must use the native variant too.
const realOf = (p) => fs.realpathSync.native(p);

let tmp;
let music;
let db;
let app;
let parseMock;
const authFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });
let auth;

const write = (rel, content = 'ID3 fake audio bytes') => {
    const full = path.join(music, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
};

// Tags by file name; a file named "broken*" fails to parse.
const TAGS = {
    'one.mp3': { common: { title: 'Song One', artist: 'Band A', album: 'First', track: { no: 1 } }, format: { duration: 201.4, codec: 'MPEG 1 Layer 3' } },
    'two.flac': { common: { title: 'Song Two', artist: 'Band A', album: 'First', track: { no: 2 } }, format: { duration: 99, codec: 'FLAC' } },
    'three.ogg': { common: { title: 'Song 100%_off', artist: 'Band B' }, format: { duration: 60, codec: 'Vorbis I' } }
};

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-local-'));
    music = path.join(tmp, 'Music');
    fs.mkdirSync(music);
    process.env.MUSIC_DATA_DIR = path.join(tmp, 'data');
    // Temp folders are outside the home folder; allow this test's own.
    process.env.LOCAL_MUSIC_ROOTS = tmp;
    jest.resetModules();
    parseMock = jest.fn(async (file) => {
        const name = path.basename(file);
        if (name.startsWith('broken')) throw new Error('bad header');
        return TAGS[name] || { common: {}, format: {} };
    });
    // Modules were reset: patch the instances the app will use.
    require('../services/tagReader').runner.parse = parseMock;
    require('../services/localLibrary')._resetForTests();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    db = await require('../config/db')();
    app = require('../app');
    app.locals.db = db;
    await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'u1', 'x'), (2, 'u2', 'x')`);
    auth = authFor(1);
    mockStreamTranscoded.mockReset();
    mockStreamTranscoded.mockImplementation((req, res) => res.status(200).end('transcoded'));
});

afterEach(async () => {
    console.log.mockRestore();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MUSIC_DATA_DIR;
    delete process.env.LOCAL_MUSIC_ROOTS;
});

const lib = () => require('../services/localLibrary');
const addAndScan = async (userId = 1, folder = music) => {
    const { id } = await lib().addFolder(db, userId, folder);
    await lib().startScan(db, Number(id)); // joins the scan addFolder started
    return id;
};

describe('adding folders', () => {
    it('stores the real path and refuses relative paths, missing folders, files and the disk root', async () => {
        const real = await lib().resolveFolder(music);
        expect(real).toBe(realOf(music));
        await expect(lib().resolveFolder('Music')).rejects.toMatchObject({ code: 'LOCAL_BAD_PATH' });
        await expect(lib().resolveFolder(path.join(tmp, 'nope'))).rejects.toMatchObject({ code: 'LOCAL_NOT_FOUND' });
        write('file.mp3');
        await expect(lib().resolveFolder(path.join(music, 'file.mp3'))).rejects.toMatchObject({ code: 'LOCAL_NOT_A_FOLDER' });
        // The disk root is refused: as a location, or as "not a folder to pick".
        await expect(lib().resolveFolder(path.parse(tmp).root)).rejects.toMatchObject({ code: expect.stringMatching(/^LOCAL_(NOT_ALLOWED|BAD_PATH)$/) });
        await expect(lib().resolveFolder('/tmp/a\u0000b')).rejects.toMatchObject({ code: 'LOCAL_BAD_PATH' });
    });

    it('accepts ordinary folder names: spaces, parentheses, apostrophes, &, ~ and non-Latin letters', async () => {
        for (const name of ["Rock & Roll (2024)", "Guns N' Roses", 'RUNNER~1', 'מוזיקה', 'Björk – Homogenic', 'a, b + c']) {
            const dir = path.join(tmp, name);
            fs.mkdirSync(dir);
            await expect(lib().resolveFolder(dir)).resolves.toBe(realOf(dir));
        }
        // "." and ".." are simply normalised away.
        await expect(lib().resolveFolder(path.join(music, '..', 'Music', '.'))).resolves.toBe(realOf(music));
    });

    it('refuses folders outside the allowed locations, including through a symlink', async () => {
        const allowed = path.join(tmp, 'Allowed');
        const outside = path.join(tmp, 'Outside');
        fs.mkdirSync(allowed);
        fs.mkdirSync(outside);
        process.env.LOCAL_MUSIC_ROOTS = allowed;

        await expect(lib().resolveFolder(outside)).rejects.toMatchObject({ code: 'LOCAL_NOT_ALLOWED', status: 403 });
        // A sibling whose name merely starts with the root's name is outside too.
        fs.mkdirSync(path.join(tmp, 'Allowed-not'));
        await expect(lib().resolveFolder(path.join(tmp, 'Allowed-not'))).rejects.toMatchObject({ code: 'LOCAL_NOT_ALLOWED' });
        // ".." cannot be used to climb out.
        await expect(lib().resolveFolder(path.join(allowed, '..', 'Outside'))).rejects.toMatchObject({ code: 'LOCAL_NOT_ALLOWED' });
        // A link inside the allowed root that points outside is refused on its
        // real path. (On Windows the temp folder is itself inside the home
        // folder, which is always allowed, so the case cannot be built there.)
        const tmpIsInHome = realOf(tmp).toLowerCase().startsWith(realOf(os.homedir()).toLowerCase() + path.sep);
        if (!tmpIsInHome) {
            fs.symlinkSync(outside, path.join(allowed, 'link'));
            await expect(lib().resolveFolder(path.join(allowed, 'link'))).rejects.toMatchObject({ code: 'LOCAL_NOT_ALLOWED' });
        }
        // Inside the root is fine, and the home folder is always allowed.
        fs.mkdirSync(path.join(allowed, 'Albums'));
        await expect(lib().resolveFolder(path.join(allowed, 'Albums'))).resolves.toBe(realOf(path.join(allowed, 'Albums')));
        await expect(lib().resolveFolder('~')).resolves.toBe(realOf(os.homedir()));
        const res = await request(app).post('/api/local/folders').set(auth).send({ path: outside });
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('LOCAL_NOT_ALLOWED');
    });

    it('treats a symlinked alias of an added folder as a duplicate', async () => {
        await addAndScan();
        const alias = path.join(tmp, 'alias');
        fs.symlinkSync(music, alias);
        await expect(lib().addFolder(db, 1, alias)).rejects.toMatchObject({ code: 'LOCAL_DUPLICATE', status: 409 });
    });

    it('POST /api/local/folders validates, and GET lists only the caller\'s folders', async () => {
        const bad = await request(app).post('/api/local/folders').set(auth).send({ path: 'relative/path' });
        expect(bad.statusCode).toBe(400);
        expect(bad.body.code).toBe('LOCAL_BAD_PATH');
        const ok = await request(app).post('/api/local/folders').set(auth).send({ path: music });
        expect(ok.statusCode).toBe(201);
        await lib().startScan(db, Number(ok.body.id));
        const mine = await request(app).get('/api/local/folders').set(auth);
        expect(mine.body.folders).toHaveLength(1);
        const theirs = await request(app).get('/api/local/folders').set(authFor(2));
        expect(theirs.body.folders).toHaveLength(0);
        expect((await request(app).get('/api/local/folders')).statusCode).toBe(401);
    });
});

describe('scanning', () => {
    it('reads audio files and their tags, skipping hidden entries, non-audio files and symlinks', async () => {
        write('one.mp3');
        write('Album/two.flac');
        write('Album/three.ogg');
        write('notes.txt');
        write('.hidden/secret.mp3');
        write('.dotfile.mp3');
        fs.writeFileSync(path.join(tmp, 'outside.mp3'), 'x');
        fs.symlinkSync(path.join(tmp, 'outside.mp3'), path.join(music, 'link.mp3'));
        fs.symlinkSync(music, path.join(music, 'Album', 'loop')); // a directory loop
        await addAndScan();

        const rows = await db.all(`SELECT rel_path, title, artist, album, track_no, duration_sec, format FROM local_tracks ORDER BY rel_path`);
        expect(rows.map((r) => r.rel_path)).toEqual([path.join('Album', 'three.ogg'), path.join('Album', 'two.flac'), 'one.mp3']);
        expect(rows.find((r) => r.rel_path === 'one.mp3')).toMatchObject({ title: 'Song One', artist: 'Band A', album: 'First', track_no: 1, duration_sec: 201, format: 'MPEG 1 Layer 3' });
        const folder = await db.get(`SELECT file_count, scan_error, last_scan_at FROM local_folders`);
        expect(folder).toMatchObject({ file_count: 3, scan_error: null });
        expect(folder.last_scan_at).toBeGreaterThan(0);
    });

    it('uses the file name when the tags cannot be read', async () => {
        write('broken file.mp3');
        await addAndScan();
        expect(await db.get(`SELECT title, artist FROM local_tracks`)).toEqual({ title: 'broken file', artist: null });
    });

    it('rescans incrementally: unchanged files are not re-read, changed ones are, vanished ones go', async () => {
        write('one.mp3');
        const two = write('two.flac');
        const id = await addAndScan();
        expect(parseMock).toHaveBeenCalledTimes(2);

        parseMock.mockClear();
        fs.writeFileSync(two, 'different and longer content');
        fs.unlinkSync(path.join(music, 'one.mp3'));
        write('three.ogg');
        await lib().rescanFolder(db, 1, id);
        await lib().startScan(db, Number(id));

        expect(parseMock.mock.calls.map((c) => path.basename(c[0])).sort()).toEqual(['three.ogg', 'two.flac']);
        const rows = await db.all(`SELECT rel_path FROM local_tracks ORDER BY rel_path`);
        expect(rows.map((r) => r.rel_path)).toEqual(['three.ogg', 'two.flac']);
    });

    it('reports a folder that disappeared', async () => {
        const id = await addAndScan();
        fs.rmSync(music, { recursive: true });
        await lib().rescanFolder(db, 1, id);
        await lib().startScan(db, Number(id));
        expect((await db.get(`SELECT scan_error FROM local_folders`)).scan_error).toMatch(/no longer exists/);
    });
});

describe('library and search (source=local)', () => {
    beforeEach(async () => {
        write('one.mp3');
        write('Album/two.flac');
        write('three.ogg');
        await addAndScan();
    });

    it('lists each folder as a playlist and its tracks in artist / album / track order', async () => {
        const pl = await request(app).get('/api/library/local/playlists').set(auth);
        expect(pl.body.items).toEqual([expect.objectContaining({ source: 'local', name: 'Music', itemCount: 3 })]);
        const tracks = await request(app).get(`/api/library/local/playlists/${pl.body.items[0].id}/tracks`).set(auth);
        expect(tracks.body.items.map((t) => t.title)).toEqual(['Song One', 'Song Two', 'Song 100%_off']);
        expect(tracks.body.items[0]).toMatchObject({ source: 'local', artist: 'Band A', album: 'First', durationSec: 201, playable: true });
        // Another user cannot open this folder.
        const other = await request(app).get(`/api/library/local/playlists/${pl.body.items[0].id}/tracks`).set(authFor(2));
        expect(other.statusCode).toBe(404);
    });

    it('searches title, artist and album, with % and _ taken literally', async () => {
        const res = await request(app).get('/api/search/local?q=band a').set(auth);
        expect(res.body.items.map((t) => t.title)).toEqual(['Song One', 'Song Two']);
        const literal = await request(app).get(`/api/search/local?q=${encodeURIComponent('100%_')}`).set(auth);
        expect(literal.body.items.map((t) => t.title)).toEqual(['Song 100%_off']);
        const wild = await request(app).get(`/api/search/local?q=${encodeURIComponent('%')}`).set(auth);
        expect(wild.body.items.map((t) => t.title)).toEqual(['Song 100%_off']);
        const otherUser = await request(app).get('/api/search/local?q=song').set(authFor(2));
        expect(otherUser.body.items).toEqual([]);
    });
});

describe('playback (/stream?source=local)', () => {
    let ids;
    beforeEach(async () => {
        write('one.mp3', Buffer.alloc(5000, 7));
        write('three.ogg', Buffer.alloc(3000, 1));
        await addAndScan();
        ids = Object.fromEntries((await db.all(`SELECT id, rel_path FROM local_tracks`)).map((r) => [r.rel_path, String(r.id)]));
    });

    it('sends MP3 / M4A / FLAC / WAV as they are, with HTTP range support', async () => {
        const full = await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}`));
        expect(full.statusCode).toBe(200);
        expect(full.headers['content-type']).toMatch(/^audio\/mpeg/);
        expect(full.headers['accept-ranges']).toBe('bytes');
        expect(full.headers['cross-origin-resource-policy']).toBe('cross-origin');
        expect(Number(full.headers['content-length'])).toBe(5000);
        const part = await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}`)).set('Range', 'bytes=100-199');
        expect(part.statusCode).toBe(206);
        expect(Number(part.headers['content-length'])).toBe(100);
        expect(mockStreamTranscoded).not.toHaveBeenCalled();
    });

    it('transcodes other formats, and any seek, through ffmpeg with a file: input', async () => {
        await request(app).get(withMedia(`/stream?source=local&videoId=${ids['three.ogg']}`));
        await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}&seek=42`));
        const [ogg, seek] = mockStreamTranscoded.mock.calls.map((c) => c[2]);
        expect(ogg).toMatchObject({ sourceUrl: `file:${realOf(path.join(music, 'three.ogg'))}`, seekTime: 0, allowCache: false });
        expect(seek).toMatchObject({ sourceUrl: `file:${realOf(path.join(music, 'one.mp3'))}`, seekTime: 42 });
    });

    it("refuses another user's track", async () => {
        const res = await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}`, 2));
        expect(res.statusCode).toBe(404);
        expect(res.body).toMatchObject({ code: 'TRACK_UNAVAILABLE', source: 'local' });
    });

    it('refuses a file that was swapped for a symlink pointing outside the folder after the scan', async () => {
        const target = path.join(tmp, 'private.mp3');
        fs.writeFileSync(target, 'not yours');
        fs.unlinkSync(path.join(music, 'one.mp3'));
        fs.symlinkSync(target, path.join(music, 'one.mp3'));
        const res = await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}`));
        expect(res.statusCode).toBe(404);
    });

    it('refuses a database row whose path points outside the folder', async () => {
        await db.run(`UPDATE local_tracks SET rel_path = ? WHERE id = ?`, [path.join('..', 'outside.mp3'), Number(ids['one.mp3'])]);
        fs.writeFileSync(path.join(tmp, 'outside.mp3'), 'x');
        const res = await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}`));
        expect(res.statusCode).toBe(404);
    });

    it('answers 404 for a deleted file, 400 for a bad id, and 401 without a media token', async () => {
        fs.unlinkSync(path.join(music, 'one.mp3'));
        expect((await request(app).get(withMedia(`/stream?source=local&videoId=${ids['one.mp3']}`))).statusCode).toBe(404);
        expect((await request(app).get(withMedia('/stream?source=local&videoId=../etc/passwd'))).statusCode).toBe(400);
        expect((await request(app).get(`/stream?source=local&videoId=${ids['three.ogg']}`)).statusCode).toBe(401);
    });

    it('/duration reports the scanned length', async () => {
        await db.run(`UPDATE local_tracks SET duration_sec = 201 WHERE id = ?`, [Number(ids['one.mp3'])]);
        const res = await request(app).get(withMedia(`/duration?source=local&videoId=${ids['one.mp3']}`));
        expect(res.body).toEqual({ duration: 201 });
    });
});

describe('removing a folder', () => {
    it('removes its tracks, only for its owner, and leaves the files alone', async () => {
        write('one.mp3');
        const id = await addAndScan();
        expect((await request(app).delete(`/api/local/folders/${id}`).set(authFor(2))).statusCode).toBe(404);
        expect((await request(app).delete(`/api/local/folders/${id}`).set(auth)).statusCode).toBe(204);
        expect((await db.get(`SELECT COUNT(*) AS n FROM local_tracks`)).n).toBe(0);
        expect(fs.existsSync(path.join(music, 'one.mp3'))).toBe(true);
    });
});
