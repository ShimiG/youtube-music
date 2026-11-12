// Cloud sync (services/cloud/): two "computers" (two real databases) linked to
// one cloud account, syncing through a stand-in for the Worker that follows
// its rules (cloud/src/sync.ts): newest change wins, equal times go to the
// larger device id, every accepted change gets the account's next number.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let tmp;
let app;
let sync;
let client;
let cloud;
let A; // { db, userId, auth }
let B;

const { fakeCloud, WORKER } = require('./helpers/fakeCloud');

// --- Two computers --------------------------------------------------------------
async function computer(name, userId) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    const db = await require('../config/db')(path.join(dir, 'database.sqlite'));
    await db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [userId, `local-${name}`, 'x']);
    const auth = { Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };
    return { db, userId, auth };
}

// Runs an API call against one computer (the app is shared; its database is not).
const on = (c) => ({
    get: (url) => { app.locals.db = c.db; return request(app).get(url).set(c.auth); },
    post: (url, body) => { app.locals.db = c.db; return request(app).post(url).set(c.auth).send(body); },
    put: (url, body) => { app.locals.db = c.db; return request(app).put(url).set(c.auth).send(body); },
    del: (url) => { app.locals.db = c.db; return request(app).delete(url).set(c.auth); }
});

const play = (c, id, title, source = 'youtube') => on(c).post('/history', { trackId: id, title, artist: 'Band', source });
const newPlaylist = async (c, name) => (await on(c).post('/api/custom-playlists', { name })).body.id;
const addTrack = (c, playlistId, id, title, sourceName = 'youtube') =>
    on(c).post(`/api/custom-playlists/${playlistId}/tracks`, { sourceName, externalId: id, title, artist: 'Band', thumbnail: `https://i.ytimg.com/vi/${id}/default.jpg` });
const playlists = async (c) => (await on(c).get('/api/custom-playlists')).body.map((p) => `${p.name} (${p.itemCount})`).sort();
const tracksOf = async (c, name) => {
    const list = (await on(c).get('/api/custom-playlists')).body.find((p) => p.name === name);
    return list ? (await on(c).get(`/api/custom-playlists/${list.id}/tracks`)).body.map((t) => t.title) : null;
};
const history = async (c) => (await on(c).get('/history')).body.map((h) => h.title);
const linkAs = (c, password = 'correct horse', extra = {}) => on(c).post('/api/cloud/link', { username: 'Shimi', password, ...extra });
const syncNow = (c) => sync.syncNow(c.db, c.userId);
// A changes something, both sync: A pushes, B pulls.
const settle = async () => { await syncNow(A); await syncNow(B); await syncNow(A); };

// Every test here builds two real databases and derives the account key the
// slow way on purpose (scrypt). That is a third of a second on a fast disk and
// several seconds on the Windows build machine, so the default 5 s is too tight.
jest.setTimeout(30000);
const derivedKeys = new Map();

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cloud-'));
    delete process.env.CLOUD_URL;
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app = require('../app');
    sync = require('../services/cloud/sync');
    client = require('../services/cloud/client');
    cloud = fakeCloud();
    client.http.fetch = cloud.fetch;
    // The key is the real one, worked out once per name and password for the
    // whole file instead of twice per test (it is slow by design).
    const derive = client.deriveAuthKey;
    client.deriveAuthKey = (username, password) => {
        const id = JSON.stringify([username, password]);
        if (!derivedKeys.has(id)) derivedKeys.set(id, derive(username, password));
        return derivedKeys.get(id);
    };
    A = await computer('a', 1);
    B = await computer('b', 2);
    for (const c of [A, B]) await sync.saveCloudUrl(c.db, WORKER);
});

afterEach(async () => {
    sync._reset();
    console.log.mockRestore();
    console.warn.mockRestore();
    await A.db.close();
    await B.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CLOUD_URL;
});

describe('the cloud address', () => {
    it('accepts https addresses only (http just for a Worker on this computer), and only the bare address', () => {
        expect(client.normalizeUrl(' https://music-manager-cloud.me.workers.dev/ ')).toBe('https://music-manager-cloud.me.workers.dev');
        expect(client.normalizeUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
        expect(client.normalizeUrl('http://localhost:8787')).toBe('http://localhost:8787');
        for (const bad of [
            '', undefined, 42, 'not a url', 'http://example.com', 'ftp://example.com', 'file:///etc/passwd',
            'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'https://example.com/#frag',
            'http://192.168.1.5:8787', `https://${'a'.repeat(300)}.com`
        ]) {
            expect(() => client.normalizeUrl(bad)).toThrow(expect.objectContaining({ code: 'BAD_URL' }));
        }
    });

    it('is the owner\'s to set, is checked before it is saved, and CLOUD_URL wins over it', async () => {
        const C = await computer('c', 5); // the first account here is 5, so user 5 is the owner
        await C.db.run(`INSERT INTO users (id, username, password) VALUES (9, 'later', 'x')`);
        const later = { ...C, userId: 9, auth: { Authorization: `Bearer ${jwt.sign({ userId: 9, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` } };

        expect((await on(later).put('/api/cloud/url', { url: WORKER })).statusCode).toBe(403);
        expect((await on(C).get('/api/cloud/status')).body).toMatchObject({ configured: false, canConfigure: true, linked: false, state: 'off' });
        expect((await on(later).get('/api/cloud/status')).body.canConfigure).toBe(false);

        // Not our service, unreachable, not https: refused, nothing saved.
        expect((await on(C).put('/api/cloud/url', { url: 'https://example.com' })).body.code).toBe('CLOUD_BAD_URL');
        expect((await on(C).put('/api/cloud/url', { url: 'http://example.com' })).body.code).toBe('CLOUD_BAD_URL');
        cloud.down = true;
        expect((await on(C).put('/api/cloud/url', { url: WORKER })).statusCode).toBe(502);
        cloud.down = false;
        expect((await on(C).get('/api/cloud/status')).body.configured).toBe(false);

        const saved = await on(C).put('/api/cloud/url', { url: `${WORKER}/` });
        expect(saved.body).toMatchObject({ configured: true, url: WORKER, registrationOpen: true });

        process.env.CLOUD_URL = 'https://built-in.example.workers.dev';
        expect((await on(C).get('/api/cloud/status')).body).toMatchObject({ url: 'https://built-in.example.workers.dev', urlFromEnv: true, canConfigure: false });
        expect((await on(C).put('/api/cloud/url', { url: WORKER })).statusCode).toBe(409);
        await C.db.close();
    });
});

describe('linking a computer to the cloud account', () => {
    it('turns the password into a key here: the same on every computer, never the password itself', async () => {
        const key = await client.deriveAuthKey('Shimi', 'correct horse');
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(await client.deriveAuthKey(' shimi ', 'correct horse')).toBe(key);
        expect(await client.deriveAuthKey('shimi', 'correct horsf')).not.toBe(key);
        expect(await client.deriveAuthKey('other', 'correct horse')).not.toBe(key);
    });

    it('creates the account with a registration code, signs in on the second computer, and stores no password', async () => {
        const created = await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        expect(created.statusCode).toBe(200);
        expect(created.body).toMatchObject({ linked: true, username: 'Shimi', state: 'ok', result: { ok: true } });
        expect(JSON.stringify(created.body)).not.toMatch(/session-\d/);

        expect((await linkAs(B, 'wrong password')).body).toMatchObject({ code: 'CLOUD_BAD_CREDENTIALS' });
        expect((await on(B).get('/api/cloud/status')).body.linked).toBe(false);
        expect((await linkAs(B)).body.linked).toBe(true);

        // Neither the password, the derived key nor the session in clear text is in the database.
        const key = await client.deriveAuthKey('Shimi', 'correct horse');
        const dump = JSON.stringify(await A.db.all('SELECT * FROM cloud_links'));
        expect(dump).not.toContain('correct horse');
        expect(dump).not.toContain(key);
        expect(dump).not.toMatch(/session-\d/);
        expect((await A.db.get('SELECT session FROM cloud_links')).session).toMatch(/^enc:v1:/);
        // The cloud saw the key, not the password.
        expect(cloud.calls.filter((c) => c === 'POST /auth/login').length).toBe(2);
    });

    it('needs a login here, an address, and a name and password', async () => {
        expect((await request(app).get('/api/cloud/status')).statusCode).toBe(401);
        expect((await request(app).post('/api/cloud/link').send({ username: 'a', password: 'b' })).statusCode).toBe(401);
        expect((await on(A).post('/api/cloud/link', { username: 'Shimi' })).body.code).toBe('CLOUD_BAD_INPUT');
        expect((await linkAs(A, 'pw', { registrationCode: 'wrong' })).body.code).toBe('CLOUD_BAD_REGISTRATION_CODE');
        await sync.clearCloudUrl(A.db);
        expect((await linkAs(A)).body.code).toBe('CLOUD_NOT_CONFIGURED');
    });
});

describe('the same data on both computers', () => {
    beforeEach(async () => {
        const mix = await newPlaylist(A, 'Road Trip');
        await addTrack(A, mix, 'aaaaaaaaaaa', 'Song One');
        await addTrack(A, mix, 'bbbbbbbbbbb', 'Song Two');
        await newPlaylist(A, 'Empty');
        await play(A, 'aaaaaaaaaaa', 'Song One');
        await play(A, 'ccccccccccc', 'Song Three', 'soundcloud');
        // Plays are stored to the second; real ones are never in the same one.
        await A.db.run(`UPDATE history SET played_at = datetime('now', '-1 hour') WHERE title = 'Song One'`);
    });

    it('what was on the first computer appears on the second when it links', async () => {
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        expect(cloud.records().map((r) => r.collection).sort()).toEqual(['history', 'history', 'playlist_tracks', 'playlist_tracks', 'playlists', 'playlists']);

        expect(await playlists(B)).toEqual([]);
        await linkAs(B);
        expect(await playlists(B)).toEqual(['Empty (0)', 'Road Trip (2)']);
        expect(await tracksOf(B, 'Road Trip')).toEqual(['Song One', 'Song Two']);
        expect(await history(B)).toEqual(['Song Three', 'Song One']);
        // The Library screen reads playlists through the generic API: same order there.
        const viaLibrary = (await on(B).get('/api/library/custom/playlists')).body.items.find((p) => p.name === 'Road Trip');
        expect((await on(B).get(`/api/library/custom/playlists/${viaLibrary.id}/tracks`)).body.items.map((t) => t.title)).toEqual(['Song One', 'Song Two']);
        // The tracks arrive whole: source, id and cover.
        const mix = (await on(B).get('/api/custom-playlists')).body.find((p) => p.name === 'Road Trip');
        expect((await on(B).get(`/api/custom-playlists/${mix.id}/tracks`)).body[0])
            .toEqual({ id: 'aaaaaaaaaaa', title: 'Song One', channelTitle: 'Band', image: 'https://i.ytimg.com/vi/aaaaaaaaaaa/default.jpg', source: 'youtube' });
    });

    it('both computers had data before linking: nothing is lost, each gets the other\'s', async () => {
        await newPlaylist(B, 'Focus');
        await play(B, 'ddddddddddd', 'Song Four');
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
        await syncNow(A);
        for (const c of [A, B]) {
            expect(await playlists(c)).toEqual(['Empty (0)', 'Focus (0)', 'Road Trip (2)']);
            expect((await history(c)).sort()).toEqual(['Song Four', 'Song One', 'Song Three']);
        }
    });

    it('changes travel in both directions, deletions included', async () => {
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);

        // B adds a track to A's playlist and a playlist of its own.
        const mixOnB = (await on(B).get('/api/custom-playlists')).body.find((p) => p.name === 'Road Trip').id;
        await addTrack(B, mixOnB, 'eeeeeeeeeee', 'Song Five', 'audius');
        await newPlaylist(B, 'From B');
        await play(B, 'eeeeeeeeeee', 'Song Five', 'audius');
        await syncNow(B);
        await syncNow(A);
        expect(await tracksOf(A, 'Road Trip')).toEqual(['Song One', 'Song Two', 'Song Five']);
        expect(await playlists(A)).toEqual(['Empty (0)', 'From B (0)', 'Road Trip (3)']);
        expect((await history(A))[0]).toBe('Song Five');

        // A removes a track and a whole playlist (no screen for it yet, so directly).
        await A.db.run(`DELETE FROM playlist_tracks WHERE title = 'Song Two'`);
        await A.db.run(`DELETE FROM playlists WHERE name = 'Empty'`);
        await settle();
        expect(await tracksOf(B, 'Road Trip')).toEqual(['Song One', 'Song Five']);
        expect(await playlists(B)).toEqual(['From B (0)', 'Road Trip (2)']);
        // Deleting a playlist takes its tracks with it, on the other computer too.
        await B.db.run(`DELETE FROM playlists WHERE name = 'Road Trip'`);
        await syncNow(B);
        await syncNow(A);
        expect(await playlists(A)).toEqual(['From B (0)']);
        expect(await A.db.get('SELECT COUNT(*) AS n FROM playlist_tracks')).toEqual({ n: 0 });
    });

    it('the same playlist renamed on both: the later rename wins on both', async () => {
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
        await A.db.run(`UPDATE playlists SET name = 'Renamed on A' WHERE name = 'Road Trip'`);
        await syncNow(A);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await B.db.run(`UPDATE playlists SET name = 'Renamed on B, later' WHERE name = 'Road Trip'`);
        await syncNow(B); // B has not seen A's rename yet; its own is newer
        await syncNow(A);
        await syncNow(B);
        expect(await playlists(A)).toEqual(['Empty (0)', 'Renamed on B, later (2)']);
        expect(await playlists(B)).toEqual(['Empty (0)', 'Renamed on B, later (2)']);
    });

    it('a run with nothing to do sends nothing', async () => {
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
        await settle();
        cloud.pushes.length = 0;
        await settle();
        await settle();
        expect(cloud.pushes).toEqual([]);
        expect((await on(A).get('/api/cloud/status')).body).toMatchObject({ pending: 0, lastError: null });
    });

    it('tracks from Local Files stay on their own computer', async () => {
        const mix = (await on(A).get('/api/custom-playlists')).body.find((p) => p.name === 'Road Trip').id;
        await addTrack(A, mix, '17', 'A file on this disk', 'local');
        await play(A, '17', 'A file on this disk', 'local');
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
        expect(JSON.stringify(cloud.records())).not.toContain('A file on this disk');
        expect(await tracksOf(B, 'Road Trip')).toEqual(['Song One', 'Song Two']);
        expect(await tracksOf(A, 'Road Trip')).toEqual(['Song One', 'Song Two', 'A file on this disk']);
        // And a later sync does not take it for something to delete.
        await settle();
        expect(await tracksOf(A, 'Road Trip')).toContain('A file on this disk');
    });
});

describe('play history', () => {
    it('merges by track: the latest play counts, and both keep the same newest 50', async () => {
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
        // 40 plays on each, at known times, 10 of them of the same tracks.
        const at = (minutes) => Math.floor(Date.now() / 1000) - 7200 + minutes * 60;
        // In one transaction per computer: 80 plays written one by one take
        // several seconds on a slow disk (the Windows build machine).
        const seed = async (c, prefix, offset) => {
            await c.db.exec('BEGIN');
            for (let i = 0; i < 40; i++) {
                const id = (i < 10 ? `shared${i}` : `${prefix}${i}`).padEnd(11, 'x');
                await play(c, id, i < 10 ? `Shared ${i}` : `${prefix.toUpperCase()} ${i}`);
                await c.db.run(`UPDATE history SET played_at = datetime(?, 'unixepoch') WHERE id = (SELECT MAX(id) FROM history)`, [at(i * 2 + offset)]);
            }
            await c.db.exec('COMMIT');
        };
        await seed(A, 'a', 0);
        await seed(B, 'b', 1); // B's plays are each a minute after A's
        await settle();
        await syncNow(B);
        await syncNow(A);

        const onA = await history(A);
        const onB = await history(B);
        expect(onA).toHaveLength(50);
        expect(onB).toEqual(onA);
        // 70 different tracks were played in all; the 50 newest are kept: the
        // last 25 of each computer. The shared tracks were played first, so
        // they are among the oldest and have dropped out.
        expect(onA[0]).toBe('B 39');
        expect(onA[1]).toBe('A 39');
        expect(onA.filter((t) => t.startsWith('Shared'))).toEqual([]);
        expect(onA.filter((t) => t.startsWith('A ')).length).toBe(25);
    });

    it('playing a track again moves it to the top everywhere', async () => {
        await play(A, 'aaaaaaaaaaa', 'Song One');
        await play(A, 'bbbbbbbbbbb', 'Song Two');
        await A.db.run(`UPDATE history SET played_at = datetime('now', '-1 hour')`);
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
        await play(B, 'aaaaaaaaaaa', 'Song One');
        await syncNow(B);
        await syncNow(A);
        expect((await history(A))[0]).toBe('Song One');
        expect(await history(A)).toHaveLength(2);
    });
});

describe('when things go wrong', () => {
    beforeEach(async () => {
        await newPlaylist(A, 'Road Trip');
        await linkAs(A, 'correct horse', { registrationCode: 'let-me-in' });
        await linkAs(B);
    });

    it('an unreachable cloud is reported and tried again; what changed meanwhile is sent then', async () => {
        cloud.down = true;
        await newPlaylist(A, 'Made offline');
        const failed = await on(A).post('/api/cloud/sync');
        expect(failed.statusCode).toBe(200);
        expect(failed.body).toMatchObject({ linked: true, state: 'ok', lastError: 'The cloud service could not be reached.', pending: 1, result: { ok: false, reason: 'failed' } });
        expect(await playlists(A)).toEqual(['Made offline (0)', 'Road Trip (0)']); // nothing lost here

        cloud.down = false;
        expect((await on(A).post('/api/cloud/sync')).body).toMatchObject({ lastError: null, pending: 0, result: { ok: true } });
        await syncNow(B);
        expect(await playlists(B)).toEqual(['Made offline (0)', 'Road Trip (0)']);
    });

    it('a session the cloud no longer accepts stops the runs until the user signs in again', async () => {
        cloud.rejectSessions = true;
        expect(await syncNow(A)).toMatchObject({ ok: false, reason: 'signin_required' });
        expect((await on(A).get('/api/cloud/status')).body).toMatchObject({ linked: true, state: 'signin_required' });
        const before = cloud.calls.length;
        expect(await syncNow(A)).toMatchObject({ ok: false, reason: 'signin_required' });
        expect(cloud.calls.length).toBe(before); // not even asked

        cloud.rejectSessions = false;
        await newPlaylist(A, 'While signed out');
        expect((await linkAs(A)).body).toMatchObject({ state: 'ok', result: { ok: true } });
        await syncNow(B);
        // Signing in again continues where it stopped: no duplicates.
        expect(await playlists(B)).toEqual(['Road Trip (0)', 'While signed out (0)']);
        expect(await playlists(A)).toEqual(['Road Trip (0)', 'While signed out (0)']);
    });

    it('renews the session before it runs out, and copes with a cloud that cannot renew', async () => {
        await A.db.run('UPDATE cloud_links SET session_expires_at = ?', [Date.now() + 2 * 24 * 60 * 60 * 1000]);
        const old = (await A.db.get('SELECT session FROM cloud_links')).session;
        expect(await syncNow(A)).toMatchObject({ ok: true });
        expect(cloud.calls).toContain('POST /auth/refresh');
        const row = await A.db.get('SELECT session, session_expires_at FROM cloud_links');
        expect(row.session).not.toBe(old);
        expect(row.session_expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

        // A fresh session is not renewed on every run.
        const refreshes = cloud.calls.filter((c) => c === 'POST /auth/refresh').length;
        await syncNow(A);
        expect(cloud.calls.filter((c) => c === 'POST /auth/refresh').length).toBe(refreshes);
    });

    it('a record this computer cannot use is left alone in the cloud, not deleted from it', async () => {
        const account = cloud.records();
        const playlistId = account.find((r) => r.collection === 'playlists').id;
        // Another, newer version of the app synced a track from a source this one does not know.
        await cloud.fetch(`${WORKER}/sync/push`, {
            method: 'POST',
            headers: { Authorization: 'Bearer session-1' },
            body: JSON.stringify({ deviceId: 'mm-zzzzzzzzzzzz', changes: [
                { collection: 'playlist_tracks', id: `${playlistId}:0000000000000000000000000000000000000000`, updatedAt: Date.now(), data: { playlist: playlistId, source: 'futuresource', externalId: 'x1', title: 'From the future', artist: null, thumbnail: null } },
                { collection: 'podcasts', id: 'p1', updatedAt: Date.now(), data: { name: 'Unknown collection' } }
            ] })
        });
        await settle();
        await settle();
        expect(await tracksOf(A, 'Road Trip')).toEqual([]);
        const kept = cloud.records().filter((r) => !r.deleted).map((r) => r.collection).sort();
        expect(kept).toEqual(['playlist_tracks', 'playlists', 'podcasts']);
    });

    it('disconnecting stops the sync and keeps the data on both sides', async () => {
        const res = await on(A).del('/api/cloud/link');
        expect(res.body).toMatchObject({ linked: false, state: 'off' });
        expect(await playlists(A)).toEqual(['Road Trip (0)']);
        expect(cloud.records().filter((r) => !r.deleted)).toHaveLength(1);
        expect(await syncNow(A)).toMatchObject({ ok: false, reason: 'not_linked' });
        // Linking again finds the same playlist, not a second copy of it.
        await linkAs(A);
        await syncNow(B);
        expect(await playlists(A)).toEqual(['Road Trip (0)']);
        expect(await playlists(B)).toEqual(['Road Trip (0)']);
    });
});
