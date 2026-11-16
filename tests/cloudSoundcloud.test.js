// Credentials live in the cloud service, not on a computer
// (docs/cloud-data.md, "Secrets"). SoundCloud works as YouTube does: the
// Worker holds the client secret and the logins, and a computer asks it for
// tokens. Against a stand-in for the Worker (tests/helpers/fakeCloud.js);
// SoundCloud itself is a stand-in too.
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
let tokens;
let soundcloud; // controllers/soundcloud/client.js
let cloudSoundcloud;
let cloudSettings;
let cloud;
let A;
let saved;

jest.setTimeout(30000);
const derivedKeys = new Map();
const KEYS = ['SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET', 'SOUNDCLOUD_PROVIDER', 'AUDIUS_API_KEY'];
const sessionFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });

const on = (c) => ({
    get: (url) => { app.locals.db = c.db; return request(app).get(url).set(c.auth); },
    post: (url, body) => { app.locals.db = c.db; return request(app).post(url).set(c.auth).send(body); },
    del: (url) => { app.locals.db = c.db; return request(app).delete(url).set(c.auth); }
});
const soundcloudRow = (c) => c.db.get(
    `SELECT access_token, refresh_token, expires_at FROM user_connections
     WHERE user_id = ? AND source_id = (SELECT id FROM sources WHERE name = 'soundcloud')`, [c.userId]);
const sourceNamed = async (c, name) => (await on(c).get('/api/sources')).body.sources.find((s) => s.name === name);
const expire = (c) => c.db.run(`UPDATE user_connections SET expires_at = ? WHERE user_id = ?`, [Date.now() - 1000, c.userId]);
const cloudCalls = (pathname) => cloud.calls.filter((call) => call.endsWith(` ${pathname}`)).length;

// A computer signed in to the cloud account, with the cloud set up as the test says.
async function signedIn({ soundcloudConfigured = true, audiusApiKey = null } = {}) {
    cloud.soundcloudConfigured = soundcloudConfigured;
    cloud.audiusApiKey = audiusApiKey;
    const dir = fs.mkdtempSync(path.join(tmp, 'computer-'));
    const db = await require('../config/db')(path.join(dir, 'database.sqlite'));
    await db.run('INSERT INTO users (id, username, password) VALUES (1, ?, ?)', ['local', 'x']);
    await sync.saveCloudUrl(db, WORKER);
    const c = { db, userId: 1, auth: sessionFor(1) };
    const res = await on(c).post('/api/cloud/login', { username: 'Shimi', password: 'correct horse', registrationCode: 'let-me-in' });
    expect(res.statusCode).toBe(200);
    return c;
}

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cloud-sc-'));
    delete process.env.CLOUD_URL;
    delete process.env.BUILT_IN_CLOUD_URL;
    // This computer has no credentials of its own.
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    app = require('../app');
    sync = require('../services/cloud/sync');
    client = require('../services/cloud/client');
    connections = require('../services/connections');
    tokens = require('../controllers/soundcloud/tokens');
    soundcloud = require('../controllers/soundcloud/client');
    cloudSoundcloud = require('../services/cloud/soundcloud');
    cloudSettings = require('../services/cloud/settings');
    cloud = fakeCloud();
    client.http.fetch = cloud.fetch;
    const derive = client.deriveAuthKey;
    client.deriveAuthKey = (username, password) => {
        const id = JSON.stringify([username, password]);
        if (!derivedKeys.has(id)) derivedKeys.set(id, derive(username, password));
        return derivedKeys.get(id);
    };
    // SoundCloud's token address is never called from a computer in this file.
    soundcloud.http.fetch = jest.fn(async () => { throw new Error('no call to SoundCloud expected'); });
    A = null;
});

afterEach(async () => {
    sync._reset();
    tokens._resetCaches();
    console.log.mockRestore();
    console.warn.mockRestore();
    if (A) await A.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
});

describe('SoundCloud is set up in the cloud service, not on the computer', () => {
    it('cannot be connected when neither has its credentials', async () => {
        A = await signedIn({ soundcloudConfigured: false });
        expect((await sourceNamed(A, 'soundcloud')).connect.available).toBe(false);
        expect((await on(A).get('/api/soundcloud/status')).body).toMatchObject({ provider: 'ytdlp', apiConfigured: false, viaCloud: false, connectAvailable: false });
        expect(await on(A).get('/auth/soundcloud/url')).toMatchObject({ statusCode: 503, body: { code: 'SOUNDCLOUD_NOT_CONFIGURED' } });
    });

    it('can be connected with no credentials on this computer once the cloud has them', async () => {
        A = await signedIn();
        // Signing in asked the cloud once.
        expect((await sourceNamed(A, 'soundcloud')).connect.available).toBe(true);
        expect((await sourceNamed(A, 'soundcloud')).connected).toBe(false);
        expect((await on(A).get('/api/soundcloud/status')).body).toMatchObject({ provider: 'api', apiConfigured: true, viaCloud: true, connectAvailable: true, libraryAvailable: true });
        expect((await on(A).get('/api/cloud/status')).body.soundcloud).toEqual({ available: true, connected: false });

        const web = await on(A).get('/auth/soundcloud/url');
        expect(web.statusCode).toBe(200);
        expect(web.body).toEqual({ url: expect.stringMatching(/^https:\/\/secure\.soundcloud\.com\/authorize.*state=signed-by-the-cloud-1$/), via: 'cloud' });
        // The cloud is told where to send the browser back; nothing from the request itself.
        expect(cloud.soundcloudStarts[0]).toEqual({ returnTo: 'http://localhost:5173' });
        await on(A).get('/auth/soundcloud/url?return=app');
        expect(cloud.soundcloudStarts[1]).toEqual({ returnTo: 'app' });
        await on(A).get('/auth/soundcloud/url?return=https://evil.example');
        expect(cloud.soundcloudStarts[2]).toEqual({ returnTo: 'http://localhost:5173' });
    });

    it('learns later that the cloud was given the credentials, and remembers it over a restart', async () => {
        A = await signedIn({ soundcloudConfigured: false });
        cloud.soundcloudConfigured = true; // `wrangler secret put ...`
        expect((await on(A).get('/api/cloud/services')).body).toEqual({
            youtube: { configured: true, connected: false },
            soundcloud: { configured: true, connected: false },
            audius: { configured: false }
        });
        expect((await sourceNamed(A, 'soundcloud')).connect.available).toBe(true);

        sync._reset(); // the server stops...
        expect(cloudSoundcloud.available()).toBe(false);
        cloud.down = true;
        await sync.start(A.db); // ...and starts again, with the cloud out of reach
        expect(cloudSoundcloud.available()).toBe(true);
        cloud.down = false;
    });

    it('says the cloud could not be reached, instead of "not set up", when it cannot start the sign-in', async () => {
        A = await signedIn();
        cloud.down = true;
        expect(await on(A).get('/auth/soundcloud/url')).toMatchObject({ statusCode: 502, body: { code: 'SOURCE_UPSTREAM', source: 'soundcloud' } });
    });
});

describe("an account's SoundCloud login is kept with the cloud account", () => {
    beforeEach(async () => {
        A = await signedIn();
        cloud.connectSoundCloud();
        // The client asks for this when the browser comes back from SoundCloud.
        expect((await on(A).get('/api/cloud/services')).body.soundcloud).toEqual({ configured: true, connected: true });
    });

    it('shows as connected, and renewed without the user', async () => {
        expect((await sourceNamed(A, 'soundcloud')).connected).toBe(true);
        expect((await sourceNamed(A, 'soundcloud')).expiresAt).toBeNull();
        const list = (await on(A).get('/api/user/connections')).body;
        expect(list).toContainEqual({ source_name: 'soundcloud', expires_at: null, refreshable: 1 });
        expect((await on(A).get('/api/cloud/status')).body.soundcloud).toEqual({ available: true, connected: true });
    });

    it('gets its tokens from the cloud, and stores no refresh token here', async () => {
        expect(await connections.getSourceToken(A.db, A.userId, 'soundcloud')).toBe('sc-user-from-the-cloud-1');
        const row = await soundcloudRow(A);
        expect(row.refresh_token).toBeNull();
        expect(row.access_token).not.toContain('sc-user-from-the-cloud'); // encrypted at rest
        // While it is good, nobody is asked again.
        expect(await connections.getSourceToken(A.db, A.userId, 'soundcloud')).toBe('sc-user-from-the-cloud-1');
        expect(cloudCalls('/soundcloud/token')).toBe(1);
        // When it has run out, the cloud is asked for the next one: no "connect again".
        await expire(A);
        expect(await connections.getSourceToken(A.db, A.userId, 'soundcloud')).toBe('sc-user-from-the-cloud-2');
        expect(soundcloud.http.fetch).not.toHaveBeenCalled();
    });

    it('asks the cloud once when several requests need a token at the same moment', async () => {
        const all = await Promise.all([1, 2, 3].map(() => connections.getSourceToken(A.db, A.userId, 'soundcloud')));
        expect(new Set(all).size).toBe(1);
        expect(cloudCalls('/soundcloud/token')).toBe(1);
    });

    it('is no longer connected here once it was disconnected on another computer', async () => {
        await connections.getSourceToken(A.db, A.userId, 'soundcloud');
        cloud.disconnectSoundCloud();
        await expire(A);
        await expect(connections.getSourceToken(A.db, A.userId, 'soundcloud')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED', source: 'soundcloud' });
        expect(await soundcloudRow(A)).toBeUndefined();
        expect((await sourceNamed(A, 'soundcloud')).connected).toBe(false);
    });

    it('says "try again", not "connect again", when the cloud or SoundCloud cannot be reached', async () => {
        cloud.soundcloudDown = true;
        await expect(connections.getSourceToken(A.db, A.userId, 'soundcloud')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE', status: 502 });
        cloud.soundcloudDown = false;
        cloud.down = true;
        await expect(connections.getSourceToken(A.db, A.userId, 'soundcloud')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
        cloud.down = false;
        // Still connected: the next try works.
        expect((await sourceNamed(A, 'soundcloud')).connected).toBe(true);
        expect(await connections.getSourceToken(A.db, A.userId, 'soundcloud')).toBe('sc-user-from-the-cloud-1');
    });

    it('is disconnected in the cloud, for every computer, and not at all when the cloud cannot be reached', async () => {
        await connections.getSourceToken(A.db, A.userId, 'soundcloud');
        cloud.down = true;
        expect(await on(A).del('/api/user/connections/soundcloud')).toMatchObject({ statusCode: 502, body: { code: 'SOURCE_UPSTREAM' } });
        expect((await sourceNamed(A, 'soundcloud')).connected).toBe(true);
        cloud.down = false;

        expect((await on(A).del('/api/user/connections/soundcloud')).statusCode).toBe(204);
        expect(cloud.calls).toContain('DELETE /soundcloud');
        expect(await soundcloudRow(A)).toBeUndefined();
        expect((await sourceNamed(A, 'soundcloud')).connected).toBe(false);
        await expect(connections.getSourceToken(A.db, A.userId, 'soundcloud')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
    });
});

describe("the installation's SoundCloud token comes from the cloud", () => {
    const fallback = () => require('../controllers/soundcloud/fallback');

    it('is asked for once, kept while it is good, and no credentials are needed here', async () => {
        A = await signedIn();
        expect(await tokens.getAppToken(A.db)).toBe('sc-app-from-the-cloud-1');
        expect(await tokens.getAppToken(A.db)).toBe('sc-app-from-the-cloud-1');
        await Promise.all([tokens.getAppToken(A.db), tokens.getAppToken(A.db)]);
        expect(cloudCalls('/soundcloud/app-token')).toBe(1);
        // Nothing was asked of SoundCloud from here, and nothing stored here.
        expect(soundcloud.http.fetch).not.toHaveBeenCalled();
        expect(await A.db.get('SELECT * FROM app_tokens')).toBeUndefined();
    });

    it('searches through the official API with it', async () => {
        A = await signedIn();
        const asked = [];
        soundcloud.http.fetch = jest.fn(async (url, init) => {
            asked.push({ url: String(url), auth: init.headers.Authorization });
            return new Response(JSON.stringify({ collection: [], next_href: null }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const res = await on(A).get('/api/soundcloud/search?q=ambient');
        expect(res.statusCode).toBe(200);
        expect(asked[0].url).toContain('https://api.soundcloud.com/');
        expect(asked[0].auth).toBe('OAuth sc-app-from-the-cloud-1');
    });

    it('lets search and playback fall back to yt-dlp when the cloud cannot be reached', async () => {
        A = await signedIn();
        cloud.down = true;
        const failure = await tokens.getAppToken(A.db).catch((err) => err);
        expect(failure).toMatchObject({ name: 'SoundCloudError', code: 'SOUNDCLOUD_UNAVAILABLE', status: 503 });
        expect(fallback().shouldFallBack(failure)).toBe(true);
        cloud.down = false;
        cloud.soundcloudDown = true;
        expect(fallback().shouldFallBack(await tokens.getAppToken(A.db).catch((err) => err))).toBe(true);
    });

    it("uses this computer's own credentials only when the cloud has none", async () => {
        A = await signedIn({ soundcloudConfigured: false });
        process.env.SOUNDCLOUD_CLIENT_ID = 'local-id';
        process.env.SOUNDCLOUD_CLIENT_SECRET = 'local-secret';
        soundcloud.http.fetch = jest.fn(async () => new Response(JSON.stringify({ access_token: 'local-app-token', refresh_token: 'r', expires_in: 3600 }), { status: 200 }));
        expect(fallback().activeProvider()).toBe('api');
        expect(await tokens.getAppToken(A.db)).toBe('local-app-token');
        expect(cloudCalls('/soundcloud/app-token')).toBe(0);

        // The cloud is given the credentials: from then on it is the cloud's token.
        cloud.soundcloudConfigured = true;
        await on(A).get('/api/cloud/services');
        expect(await tokens.getAppToken(A.db)).toBe('sc-app-from-the-cloud-1');
    });
});

describe('settings that are not secrets come from the cloud too', () => {
    it('takes the Audius key from the cloud, remembers it, and lets this computer override it', async () => {
        A = await signedIn({ audiusApiKey: 'audius-key-from-the-cloud' });
        // Signing in asked.
        expect(cloudSettings.audiusApiKey()).toBe('audius-key-from-the-cloud');
        expect((await on(A).get('/api/cloud/services')).body.audius).toEqual({ configured: true });

        sync._reset();
        expect(cloudSettings.audiusApiKey()).toBeUndefined();
        cloud.down = true;
        await sync.start(A.db); // a restart with the cloud out of reach
        expect(cloudSettings.audiusApiKey()).toBe('audius-key-from-the-cloud');
        cloud.down = false;

        process.env.AUDIUS_API_KEY = 'set-on-this-computer';
        expect(cloudSettings.audiusApiKey()).toBe('set-on-this-computer');
        delete process.env.AUDIUS_API_KEY;

        // Removed in the cloud: forgotten here at the next look.
        cloud.audiusApiKey = null;
        await on(A).get('/api/cloud/services');
        expect(cloudSettings.audiusApiKey()).toBeUndefined();
    });

    it('accepts only plain text for it', async () => {
        A = await signedIn({ audiusApiKey: 'bad key\r\nX-Injected: 1' });
        expect(cloudSettings.audiusApiKey()).toBeUndefined();
        cloud.audiusApiKey = { not: 'text' };
        await on(A).get('/api/cloud/services');
        expect(cloudSettings.audiusApiKey()).toBeUndefined();
    });
});
