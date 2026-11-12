// "Connect everything" (docs/cloud-data.md): a computer needs nothing but the
// cloud account. Two parts, both against a stand-in for the Worker:
//   - YouTube through the cloud account: the cloud holds the Google
//     credentials and the login; this computer only asks it for a token.
//   - Signing in to the app with the cloud account, on a computer that has
//     never seen the user.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { fakeCloud, WORKER } = require('./helpers/fakeCloud');

let tmp;
let app;
let sync;
let client;
let connections;
let cloud;
let A; // a computer with a local account, linked to the cloud account
let savedGoogle;

// Real databases, bcrypt and scrypt in every test: slow on the Windows build machine.
jest.setTimeout(30000);
const derivedKeys = new Map();

const sessionFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });

// A computer: its own database, and (unless it is brand new) one local account.
async function computer(name, { user = true, cloudAddress = true } = {}) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    const db = await require('../config/db')(path.join(dir, 'database.sqlite'));
    let userId = null;
    if (user) {
        userId = 1;
        await db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [userId, `local-${name}`, 'x']);
    }
    if (cloudAddress) await sync.saveCloudUrl(db, WORKER);
    return { db, userId, auth: user ? sessionFor(userId) : {} };
}

const on = (c) => ({
    get: (url) => { app.locals.db = c.db; return request(app).get(url).set(c.auth); },
    post: (url, body) => { app.locals.db = c.db; return request(app).post(url).set(c.auth).send(body); },
    del: (url) => { app.locals.db = c.db; return request(app).delete(url).set(c.auth); }
});
const youtubeRow = (c, userId = c.userId) => c.db.get(
    `SELECT access_token, refresh_token, expires_at FROM user_connections
     WHERE user_id = ? AND source_id = (SELECT id FROM sources WHERE name = 'youtube')`, [userId]);
const sourceNamed = async (c, name) => (await on(c).get('/api/sources')).body.sources.find((s) => s.name === name);
const expire = (c) => c.db.run(`UPDATE user_connections SET expires_at = ? WHERE user_id = ?`, [Date.now() - 1000, c.userId]);
const cloudCalls = (pathname) => cloud.calls.filter((call) => call.endsWith(` ${pathname}`)).length;

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-connect-'));
    delete process.env.CLOUD_URL;
    delete process.env.BUILT_IN_CLOUD_URL;
    // This computer has no Google credentials of its own (tests/setup.js sets some).
    savedGoogle = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app = require('../app');
    sync = require('../services/cloud/sync');
    client = require('../services/cloud/client');
    connections = require('../services/connections');
    cloud = fakeCloud();
    client.http.fetch = cloud.fetch;
    const derive = client.deriveAuthKey;
    client.deriveAuthKey = (username, password) => {
        const id = JSON.stringify([username, password]);
        if (!derivedKeys.has(id)) derivedKeys.set(id, derive(username, password));
        return derivedKeys.get(id);
    };
    // Google itself is never called in this file.
    connections.http.fetch = jest.fn(async () => { throw new Error('no call to Google expected'); });

    A = await computer('a');
    const linked = await on(A).post('/api/cloud/link', { username: 'Shimi', password: 'correct horse', registrationCode: 'let-me-in' });
    expect(linked.statusCode).toBe(200);
});

afterEach(async () => {
    sync._reset();
    console.log.mockRestore();
    console.warn.mockRestore();
    await A.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.GOOGLE_CLIENT_ID = savedGoogle.id;
    process.env.GOOGLE_CLIENT_SECRET = savedGoogle.secret;
    delete process.env.BUILT_IN_CLOUD_URL;
});

describe('YouTube through the cloud account', () => {
    it('can be connected with no Google credentials on this computer, by way of the cloud', async () => {
        // Linking asked the cloud once: it can do the Google sign-in.
        expect((await sourceNamed(A, 'youtube')).connect.available).toBe(true);
        expect((await sourceNamed(A, 'youtube')).connected).toBe(false);

        const web = await on(A).get('/auth/google/url');
        expect(web.statusCode).toBe(200);
        expect(web.body).toEqual({ url: expect.stringMatching(/^https:\/\/accounts\.google\.com\/.*state=signed-by-the-cloud-1$/), via: 'cloud' });
        // The cloud is told where to send the browser back: the web client on
        // this computer, or the desktop app. Nothing from the request itself.
        expect(cloud.googleStarts[0]).toEqual({ returnTo: 'http://localhost:5173' });
        await on(A).get('/auth/google/url?return=app&scope=write');
        expect(cloud.googleStarts[1]).toEqual({ returnTo: 'app', scope: 'write' });
        await on(A).get('/auth/google/url?return=https://evil.example');
        expect(cloud.googleStarts[2]).toEqual({ returnTo: 'http://localhost:5173' });
    });

    it('once connected in the cloud, this computer gets its tokens from there and stores no refresh token', async () => {
        cloud.connectYouTube();
        // The client asks for this when the browser comes back from Google.
        expect((await on(A).get('/api/cloud/google/status')).body).toEqual({ configured: true, connected: true });

        const youtube = await sourceNamed(A, 'youtube');
        expect(youtube).toMatchObject({ connected: true, expiresAt: null });
        // "refreshable": the client must not log the user out when the hour is up.
        expect((await on(A).get('/api/user/connections')).body).toEqual([{ source_name: 'youtube', expires_at: null, refreshable: 1 }]);

        expect(await connections.getSourceToken(A.db, A.userId, 'youtube')).toBe('ya29.from-the-cloud-1');
        const row = await youtubeRow(A);
        expect(row.refresh_token).toBeNull();
        expect(row.access_token).toMatch(/^enc:v1:/);
        expect(row.access_token).not.toContain('ya29');

        // Used until it runs out; then the next one comes from the cloud.
        expect(await connections.getSourceToken(A.db, A.userId, 'youtube')).toBe('ya29.from-the-cloud-1');
        expect(cloud.googleTokens).toBe(1);
        await expire(A);
        const both = await Promise.all([
            connections.getSourceToken(A.db, A.userId, 'youtube'),
            connections.getSourceToken(A.db, A.userId, 'youtube')
        ]);
        expect(both).toEqual(['ya29.from-the-cloud-2', 'ya29.from-the-cloud-2']);
        expect(cloud.googleTokens).toBe(2);
        // Still shown as connected while the stored token is out of date.
        await expire(A);
        expect((await sourceNamed(A, 'youtube')).connected).toBe(true);
        expect(connections.http.fetch).not.toHaveBeenCalled();
    });

    it('a second computer signed in to the account has YouTube without connecting anything', async () => {
        cloud.connectYouTube();
        const B = await computer('b');
        const linked = await on(B).post('/api/cloud/link', { username: 'Shimi', password: 'correct horse' });
        expect(linked.body).toMatchObject({ linked: true, youtube: { available: true, connected: true } });
        expect((await sourceNamed(B, 'youtube')).connected).toBe(true);
        expect(await connections.getSourceToken(B.db, B.userId, 'youtube')).toBe('ya29.from-the-cloud-1');
        await B.db.close();
    });

    it('learns on the next sync that YouTube was connected, or disconnected, on another computer', async () => {
        expect((await sourceNamed(A, 'youtube')).connected).toBe(false);
        await expect(connections.getSourceToken(A.db, A.userId, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
        expect(cloudCalls('/google/token')).toBe(0); // not connected: the cloud is not even asked

        cloud.connectYouTube(); // on another computer
        await sync.syncNow(A.db, A.userId);
        expect((await sourceNamed(A, 'youtube')).connected).toBe(true);
        expect(await connections.getSourceToken(A.db, A.userId, 'youtube')).toBe('ya29.from-the-cloud-1');

        // Disconnected elsewhere, and this computer finds out when its token runs out.
        const before = cloudCalls('/google/token');
        await on(A).del('/api/user/connections/youtube'); // stands for the other computer
        cloud.connectYouTube();
        await sync.syncNow(A.db, A.userId);
        await connections.getSourceToken(A.db, A.userId, 'youtube');
        cloud.fetch(`${WORKER}/google`, { method: 'DELETE', headers: { Authorization: `Bearer session-1` } });
        await expire(A);
        await expect(connections.getSourceToken(A.db, A.userId, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
        expect(cloudCalls('/google/token')).toBeGreaterThan(before);
        expect(await youtubeRow(A)).toBeUndefined();
        expect((await sourceNamed(A, 'youtube')).connected).toBe(false);
    });

    it('says the service is unavailable, not that the login is gone, when the cloud cannot be reached', async () => {
        cloud.connectYouTube();
        await sync.syncNow(A.db, A.userId);
        cloud.down = true;
        await expect(connections.getSourceToken(A.db, A.userId, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 502 });
        const viaApi = await on(A).get('/api/library/youtube/playlists');
        expect(viaApi.statusCode).toBe(502);
        expect(viaApi.body).toMatchObject({ code: 'SOURCE_UPSTREAM', source: 'youtube' });
        expect(viaApi.body.error).toMatch(/cloud account/);
        expect((await sourceNamed(A, 'youtube')).connected).toBe(true);

        // Google down behind the cloud: the same.
        cloud.down = false;
        cloud.googleDown = true;
        await expect(connections.getSourceToken(A.db, A.userId, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
        cloud.googleDown = false;
        expect(await connections.getSourceToken(A.db, A.userId, 'youtube')).toBe('ya29.from-the-cloud-1');
    });

    it('disconnecting disconnects the cloud account, and so every computer', async () => {
        cloud.connectYouTube();
        await sync.syncNow(A.db, A.userId);
        await connections.getSourceToken(A.db, A.userId, 'youtube');

        // Not while the cloud cannot be told: it would stay connected there.
        cloud.down = true;
        const failed = await on(A).del('/api/user/connections/youtube');
        expect(failed.statusCode).toBe(502);
        expect((await sourceNamed(A, 'youtube')).connected).toBe(true);
        cloud.down = false;

        expect((await on(A).del('/api/user/connections/youtube')).statusCode).toBe(204);
        expect(cloudCalls('/google')).toBeGreaterThanOrEqual(1);
        expect(await youtubeRow(A)).toBeUndefined();
        expect((await sourceNamed(A, 'youtube')).connected).toBe(false);
        expect((await on(A).get('/api/cloud/google/status')).body).toEqual({ configured: true, connected: false });
        // The cloud revoked the login at Google; this computer had nothing to revoke.
        expect(connections.http.fetch).not.toHaveBeenCalled();
    });

    it('turning cloud sync off here takes the cloud\'s YouTube login with it, but not one made on this computer', async () => {
        cloud.connectYouTube();
        await sync.syncNow(A.db, A.userId);
        await connections.getSourceToken(A.db, A.userId, 'youtube');
        await on(A).del('/api/cloud/link');
        expect(await youtubeRow(A)).toBeUndefined();
        expect((await sourceNamed(A, 'youtube')).connected).toBe(false);

        // Linked again, but YouTube connected here with this installation's own credentials.
        await on(A).post('/api/cloud/link', { username: 'Shimi', password: 'correct horse' });
        await connections.storeConnection(A.db, A.userId, 'youtube', { accessToken: 'ya29.local', refreshToken: '1//local-refresh', expiresAt: Date.now() + 3600 * 1000 });
        await on(A).del('/api/cloud/link');
        expect((await youtubeRow(A)).refresh_token).toMatch(/^enc:v1:/);
    });

    it('a login made on this computer with its own credentials is still renewed here', async () => {
        process.env.GOOGLE_CLIENT_ID = 'local-id';
        process.env.GOOGLE_CLIENT_SECRET = 'local-secret';
        await connections.storeConnection(A.db, A.userId, 'youtube', { accessToken: 'ya29.old', refreshToken: '1//local-refresh', expiresAt: Date.now() - 1000 });
        connections.http.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.renewed-here', expires_in: 3600 }), { status: 200 }));
        expect(await connections.getSourceToken(A.db, A.userId, 'youtube')).toBe('ya29.renewed-here');
        expect(connections.http.fetch).toHaveBeenCalledTimes(1);
        expect(cloudCalls('/google/token')).toBe(0);
    });

    it('falls back to this computer\'s own credentials when the cloud has none, and says so when neither has', async () => {
        cloud.googleConfigured = false;
        const none = await on(A).get('/auth/google/url');
        expect(none.statusCode).toBe(503);
        expect(none.body.code).toBe('SOURCE_NOT_CONFIGURED');
        expect((await sourceNamed(A, 'youtube')).connect.available).toBe(false);

        process.env.GOOGLE_CLIENT_ID = 'local-id.apps.googleusercontent.com';
        process.env.GOOGLE_CLIENT_SECRET = 'local-secret';
        const local = await on(A).get('/auth/google/url');
        expect(local.statusCode).toBe(200);
        expect(local.body.via).toBeUndefined();
        expect(local.body.url).toContain('client_id=local-id.apps.googleusercontent.com');

        // The cloud unreachable: the local credentials still work; without them, a clear answer.
        cloud.googleConfigured = true;
        cloud.down = true;
        expect((await on(A).get('/auth/google/url')).body.url).toContain('client_id=local-id.apps.googleusercontent.com');
        delete process.env.GOOGLE_CLIENT_ID;
        const unreachable = await on(A).get('/auth/google/url');
        expect(unreachable.statusCode).toBe(502);
        expect(unreachable.body.code).toBe('SOURCE_UPSTREAM');
    });

    it('someone not signed in to a cloud account is not affected', async () => {
        const B = await computer('b');
        expect((await sourceNamed(B, 'youtube')).connected).toBe(false);
        expect((await on(B).get('/auth/google/url')).body.code).toBe('SOURCE_NOT_CONFIGURED');
        expect((await on(B).get('/api/cloud/google/status')).body).toEqual({ configured: false, connected: false });
        await expect(connections.getSourceToken(B.db, B.userId, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
        expect((await on(B).get('/api/cloud/status')).body.youtube).toEqual({ available: false, connected: false });
        await B.db.close();
    });
});

describe('signing in to the app with the cloud account', () => {
    const login = (c, body) => on(c).post('/api/cloud/login', body);
    const shimi = { username: 'Shimi', password: 'correct horse' };

    it('sets up a computer that has never seen the user: account, link, data and YouTube', async () => {
        const playlist = (await on(A).post('/api/custom-playlists', { name: 'Road Trip' })).body.id;
        await on(A).post(`/api/custom-playlists/${playlist}/tracks`, { sourceName: 'youtube', externalId: 'aaaaaaaaaaa', title: 'Song One', artist: 'Band' });
        await sync.syncNow(A.db, A.userId);
        cloud.connectYouTube();

        const N = await computer('new', { user: false, cloudAddress: false });
        expect((await on(N).get('/api/cloud/info')).body).toEqual({ configured: false, canSetAddress: true });
        // No address yet: it has to come with the sign-in.
        expect((await login(N, shimi)).body.code).toBe('CLOUD_NOT_CONFIGURED');
        expect((await login(N, { ...shimi, url: 'https://not-the-cloud.example' })).body.code).toBe('CLOUD_BAD_URL');

        // A sign-in that fails leaves no address behind.
        expect((await login(N, { username: 'Shimi', password: 'wrong horse', url: WORKER })).body.code).toBe('CLOUD_BAD_CREDENTIALS');
        expect((await on(N).get('/api/cloud/info')).body).toEqual({ configured: false, canSetAddress: true });

        const res = await login(N, { ...shimi, url: WORKER });
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({ token: expect.any(String), userId: 1, username: 'Shimi' });
        expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({ userId: 1, purpose: 'session' });

        // The token is a normal session on this computer, and the data is already here.
        const me = { db: N.db, userId: 1, auth: { Authorization: `Bearer ${res.body.token}` } };
        expect((await on(me).get('/api/custom-playlists')).body.map((p) => `${p.name} (${p.itemCount})`)).toEqual(['Road Trip (1)']);
        expect((await on(me).get('/api/cloud/status')).body).toMatchObject({ linked: true, username: 'Shimi', state: 'ok', youtube: { connected: true } });
        expect((await sourceNamed(me, 'youtube')).connected).toBe(true);
        // First account on the computer: it owns the settings.
        expect((await on(me).get('/api/cloud/status')).body.canConfigure).toBe(true);
        expect((await on(N).get('/api/cloud/info')).body).toEqual({ configured: true, canSetAddress: false });

        // The password is not kept as it is, nor the session in the clear.
        const dump = JSON.stringify(await N.db.all('SELECT * FROM users')) + JSON.stringify(await N.db.all('SELECT * FROM cloud_links'));
        expect(dump).not.toContain('correct horse');
        expect(dump).not.toMatch(/session-\d/);
        await N.db.close();
    });

    it('signing in again uses the same account; a wrong password creates nothing', async () => {
        const N = await computer('new', { user: false });
        const wrong = await login(N, { username: 'Shimi', password: 'wrong horse' });
        expect(wrong.statusCode).toBe(401);
        expect(wrong.body.code).toBe('CLOUD_BAD_CREDENTIALS');
        expect((await N.db.get('SELECT COUNT(*) AS n FROM users')).n).toBe(0);

        expect((await login(N, shimi)).statusCode).toBe(201);
        const again = await login(N, { username: 'shimi', password: 'correct horse' });
        expect(again.statusCode).toBe(200);
        expect(again.body).toMatchObject({ userId: 1, username: 'Shimi' });
        expect((await N.db.get('SELECT COUNT(*) AS n FROM users')).n).toBe(1);

        // An account linked from Settings is found the same way (A is "local-a" here).
        const viaLink = await login(A, shimi);
        expect(viaLink.statusCode).toBe(200);
        expect(viaLink.body).toMatchObject({ userId: A.userId, username: 'local-a' });
        expect((await on(N).post('/api/cloud/login', {})).statusCode).toBe(400);
        await N.db.close();
    });

    it('does not hand over a local account that merely has the same name', async () => {
        const B = await computer('b');
        await B.db.run(`UPDATE users SET username = 'shimi' WHERE id = 1`);
        const res = await login(B, shimi);
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('CLOUD_LOCAL_ACCOUNT_EXISTS');
        expect((await on(B).get('/api/cloud/status')).body.linked).toBe(false);
        await B.db.close();
    });

    it('the address can only be given on a computer nobody has used yet', async () => {
        const B = await computer('b', { cloudAddress: false }); // has an account, no address
        expect((await on(B).get('/api/cloud/info')).body).toEqual({ configured: false, canSetAddress: false });
        const res = await login(B, { ...shimi, url: WORKER });
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('CLOUD_NOT_CONFIGURED');
        expect((await on(B).get('/api/cloud/status')).body.configured).toBe(false);

        // And an address that is already set is not replaced by the login screen.
        const N = await computer('new', { user: false });
        await login(N, { ...shimi, url: 'https://elsewhere.example' });
        expect((await sync.cloudUrl(N.db)).url).toBe(WORKER);
        await B.db.close();
        await N.db.close();
    });

    it('still opens the account when the cloud cannot be reached, for someone who signed in here before', async () => {
        const N = await computer('new', { user: false });
        await login(N, shimi);
        cloud.down = true;
        const offline = await login(N, shimi);
        expect(offline.statusCode).toBe(200);
        expect(offline.body).toMatchObject({ userId: 1, username: 'Shimi', offline: true });
        const wrong = await login(N, { username: 'Shimi', password: 'wrong horse' });
        expect(wrong.statusCode).toBe(502);
        expect(wrong.body.code).toBe('CLOUD_UNREACHABLE');
        // Never seen here: nothing to check against.
        expect((await login(N, { username: 'Other', password: 'correct horse' })).statusCode).toBe(502);
        // The ordinary log-in works with the same name and password too.
        const local = await on(N).post('/api/login', shimi);
        expect(local.statusCode).toBe(200);
        expect(local.body.userId).toBe(1);
        await N.db.close();
    });
});

describe('a cloud address built into the app', () => {
    it('is used without anyone typing it, and cannot be changed from the app', async () => {
        process.env.BUILT_IN_CLOUD_URL = `${WORKER}/`;
        jest.resetModules();
        const builtApp = require('../app');
        const builtSync = require('../services/cloud/sync');
        const builtClient = require('../services/cloud/client');
        builtClient.http.fetch = cloud.fetch;
        builtClient.deriveAuthKey = client.deriveAuthKey;

        const dir = path.join(tmp, 'built');
        fs.mkdirSync(dir);
        const db = await require('../config/db')(path.join(dir, 'database.sqlite'));
        builtApp.locals.db = db;
        expect((await request(builtApp).get('/api/cloud/info')).body).toEqual({ configured: true, canSetAddress: false });

        const res = await request(builtApp).post('/api/cloud/login').send({ username: 'Shimi', password: 'correct horse', url: 'https://elsewhere.example' });
        expect(res.statusCode).toBe(201);
        const auth = { Authorization: `Bearer ${res.body.token}` };
        const status = (await request(builtApp).get('/api/cloud/status').set(auth)).body;
        expect(status).toMatchObject({ configured: true, url: WORKER, urlFromEnv: true, canConfigure: false, linked: true });
        const change = await request(builtApp).put('/api/cloud/url').set(auth).send({ url: 'https://elsewhere.example' });
        expect(change.statusCode).toBe(409);
        expect(change.body.code).toBe('CLOUD_URL_FROM_ENV');

        // CLOUD_URL in the environment still wins over what was built in.
        process.env.CLOUD_URL = 'https://other-cloud.example';
        expect((await builtSync.cloudUrl(db)).url).toBe('https://other-cloud.example');
        delete process.env.CLOUD_URL;
        builtSync._reset();
        await db.close();
    });
});
