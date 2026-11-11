// Settings -> Accounts and System: service credentials entered in the app
// (services/appSettings.js), disconnecting YouTube, and the server log file
// (services/logFile.js). Real database in a temp folder; Google's revoke call
// is stubbed through connections.http.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET', 'LOG_FILE'];
let saved;
let tmp;
let db;
let app;
const authFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });
const owner = () => authFor(1);
const other = () => authFor(2);

// A fresh copy of the app on the same database: what a restart does.
async function boot() {
    jest.resetModules();
    db = await require('../config/db')();
    app = require('../app');
    app.locals.db = db;
    await require('../services/appSettings').applyStored(db);
}

beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-settings-'));
    process.env.MUSIC_DATA_DIR = tmp;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await boot();
    await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'first', 'x'), (2, 'second', 'x')`);
});

afterEach(async () => {
    console.log.mockRestore();
    console.warn.mockRestore();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.MUSIC_DATA_DIR;
    for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

const GOOGLE = { GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-not-a-real-secret' };
const youtubeOf = (body) => body.services.find((s) => s.source === 'youtube');
const sourceOf = async (name, auth = owner()) => (await request(app).get('/api/sources').set(auth)).body.sources.find((s) => s.name === name);

describe('service credentials entered in the app', () => {
    it('lists what can be set up, without any value, and says who may change it', async () => {
        expect((await request(app).get('/api/settings/services')).statusCode).toBe(401);
        const res = await request(app).get('/api/settings/services').set(owner());
        expect(res.statusCode).toBe(200);
        expect(res.body.services.map((s) => s.source)).toEqual(['youtube', 'soundcloud']);
        expect(youtubeOf(res.body)).toMatchObject({
            label: 'YouTube',
            configured: false,
            managedBy: null,
            canEdit: true,
            redirectUri: 'http://localhost:3000/auth/google/callback',
            fields: [
                { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', secret: false, set: false },
                { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', secret: true, set: false }
            ]
        });
        expect(youtubeOf((await request(app).get('/api/settings/services').set(other())).body).canEdit).toBe(false);
    });

    it('makes YouTube connectable at once, without a restart', async () => {
        expect((await sourceOf('youtube')).connect.available).toBe(false);
        const before = await request(app).get('/auth/google/url').set(owner());
        expect(before.statusCode).toBe(503);
        expect(before.body.code).toBe('SOURCE_NOT_CONFIGURED');

        const save = await request(app).put('/api/settings/services/youtube').set(owner()).send({ values: GOOGLE });
        expect(save.statusCode).toBe(200);
        expect(youtubeOf(save.body)).toMatchObject({ configured: true, managedBy: 'app', canEdit: true });

        expect((await sourceOf('youtube')).connect.available).toBe(true);
        const after = await request(app).get('/auth/google/url').set(owner());
        expect(after.statusCode).toBe(200);
        const url = new URL(after.body.url);
        expect(url.hostname).toBe('accounts.google.com');
        expect(url.searchParams.get('client_id')).toBe(GOOGLE.GOOGLE_CLIENT_ID);
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/google/callback');
    });

    it('stores the values encrypted, never returns them, and applies them again after a restart', async () => {
        const save = await request(app).put('/api/settings/services/youtube').set(owner()).send({ values: GOOGLE });
        const list = await request(app).get('/api/settings/services').set(other());
        for (const text of [JSON.stringify(save.body), JSON.stringify(list.body)]) {
            expect(text).not.toContain(GOOGLE.GOOGLE_CLIENT_SECRET);
            expect(text).not.toContain(GOOGLE.GOOGLE_CLIENT_ID);
        }
        const rows = await db.all('SELECT key, value FROM app_settings ORDER BY key');
        expect(rows.map((r) => r.key)).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
        for (const row of rows) expect(row.value).toMatch(/^enc:v1:/);

        await db.close();
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        await boot();
        expect(process.env.GOOGLE_CLIENT_SECRET).toBe(GOOGLE.GOOGLE_CLIENT_SECRET);
        expect((await sourceOf('youtube')).connect.available).toBe(true);
        expect(youtubeOf((await request(app).get('/api/settings/services').set(owner())).body)).toMatchObject({ configured: true, managedBy: 'app' });
    });

    it('lets only the first account change them', async () => {
        const put = await request(app).put('/api/settings/services/youtube').set(other()).send({ values: GOOGLE });
        expect(put.statusCode).toBe(403);
        expect(put.body.code).toBe('SETTINGS_OWNER_ONLY');
        await request(app).put('/api/settings/services/youtube').set(owner()).send({ values: GOOGLE });
        expect((await request(app).delete('/api/settings/services/youtube').set(other())).statusCode).toBe(403);
        expect(process.env.GOOGLE_CLIENT_ID).toBe(GOOGLE.GOOGLE_CLIENT_ID);
        expect((await request(app).put('/api/settings/services/youtube').send({ values: GOOGLE })).statusCode).toBe(401);
    });

    it('refuses incomplete, malformed and unknown input and changes nothing', async () => {
        const put = (source, values) => request(app).put(`/api/settings/services/${source}`).set(owner()).send({ values });
        for (const values of [
            undefined, {}, { GOOGLE_CLIENT_ID: 'only-the-id' }, { ...GOOGLE, GOOGLE_CLIENT_SECRET: '' },
            { ...GOOGLE, GOOGLE_CLIENT_SECRET: 'has a space' }, { ...GOOGLE, GOOGLE_CLIENT_ID: 'line\nbreak' },
            { ...GOOGLE, GOOGLE_CLIENT_SECRET: 'x'.repeat(301) }, { ...GOOGLE, GOOGLE_CLIENT_ID: ['array'] }, { ...GOOGLE, GOOGLE_CLIENT_SECRET: 42 }
        ]) {
            const res = await put('youtube', values);
            expect([JSON.stringify(values), res.statusCode, res.body.code]).toEqual([JSON.stringify(values), 400, 'SETTINGS_BAD_VALUE']);
        }
        expect((await put('spotify', GOOGLE)).statusCode).toBe(404);
        expect((await put('__proto__', GOOGLE)).statusCode).toBe(404);
        expect(await db.get('SELECT COUNT(*) AS n FROM app_settings')).toEqual({ n: 0 });
        expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
        // Keys outside the service's own fields are ignored, not stored.
        await put('youtube', { ...GOOGLE, JWT_SECRET: 'attacker-chosen', PATH: '/tmp' });
        expect((await db.all('SELECT key FROM app_settings')).map((r) => r.key).sort()).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
        expect(process.env.JWT_SECRET).not.toBe('attacker-chosen');
    });

    it('leaves a service alone when its credentials come from the environment', async () => {
        await db.close();
        process.env.GOOGLE_CLIENT_ID = 'from-dotenv.apps.googleusercontent.com';
        process.env.GOOGLE_CLIENT_SECRET = 'from-dotenv-secret';
        await boot();
        expect(youtubeOf((await request(app).get('/api/settings/services').set(owner())).body)).toMatchObject({ configured: true, managedBy: 'env', canEdit: false });
        const put = await request(app).put('/api/settings/services/youtube').set(owner()).send({ values: GOOGLE });
        expect([put.statusCode, put.body.code]).toEqual([409, 'SETTINGS_MANAGED_BY_ENV']);
        expect((await request(app).delete('/api/settings/services/youtube').set(owner())).statusCode).toBe(409);
        expect(process.env.GOOGLE_CLIENT_ID).toBe('from-dotenv.apps.googleusercontent.com');
    });

    it('removes them again, and a stored value never overrides the environment', async () => {
        await request(app).put('/api/settings/services/youtube').set(owner()).send({ values: GOOGLE });
        const del = await request(app).delete('/api/settings/services/youtube').set(owner());
        expect(youtubeOf(del.body)).toMatchObject({ configured: false, managedBy: null });
        expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
        expect((await sourceOf('youtube')).connect.available).toBe(false);

        // Saved in the app, then the same key appears in .env: .env wins.
        await request(app).put('/api/settings/services/youtube').set(owner()).send({ values: GOOGLE });
        await db.close();
        process.env.GOOGLE_CLIENT_ID = 'from-dotenv.apps.googleusercontent.com';
        process.env.GOOGLE_CLIENT_SECRET = 'from-dotenv-secret';
        await boot();
        expect(process.env.GOOGLE_CLIENT_SECRET).toBe('from-dotenv-secret');
    });

    it('forgets the SoundCloud app token when the SoundCloud app changes', async () => {
        await db.run(`INSERT INTO app_tokens (provider, access_token, refresh_token, expires_at) VALUES ('soundcloud', 'enc:v1:old', NULL, ?)`, [Date.now() + 3600000]);
        const res = await request(app).put('/api/settings/services/soundcloud').set(owner())
            .send({ values: { SOUNDCLOUD_CLIENT_ID: 'sc-client-id', SOUNDCLOUD_CLIENT_SECRET: 'sc-client-secret' } });
        expect(res.statusCode).toBe(200);
        expect(await db.get('SELECT COUNT(*) AS n FROM app_tokens')).toEqual({ n: 0 });
        expect((await sourceOf('soundcloud')).connect.available).toBe(true);
    });
});

describe('disconnecting YouTube', () => {
    it('deletes the stored tokens and asks Google to revoke the grant', async () => {
        const connections = require('../services/connections');
        connections.http.fetch = jest.fn(async () => new Response('{}', { status: 200 }));
        await connections.storeConnection(db, 1, 'youtube', { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600000 });
        await connections.storeConnection(db, 2, 'youtube', { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() + 3600000 });

        expect((await request(app).delete('/api/user/connections/youtube')).statusCode).toBe(401);
        const res = await request(app).delete('/api/user/connections/youtube').set(owner());
        expect(res.statusCode).toBe(204);
        // Only this user's connection is gone.
        expect((await db.all('SELECT user_id FROM user_connections')).map((r) => r.user_id)).toEqual([2]);
        const [url, options] = connections.http.fetch.mock.calls[0];
        expect(url).toBe('https://oauth2.googleapis.com/revoke');
        expect(options.method).toBe('POST');
        expect(options.body.get('token')).toBe('refresh-1');
        expect((await sourceOf('youtube')).connected).toBe(false);
    });

    it('still disconnects when Google cannot be reached, and when nothing was connected', async () => {
        const connections = require('../services/connections');
        connections.http.fetch = jest.fn(async () => { throw new Error('offline'); });
        await connections.storeConnection(db, 1, 'youtube', { accessToken: 'access-1', refreshToken: null, expiresAt: Date.now() + 3600000 });
        expect((await request(app).delete('/api/user/connections/youtube').set(owner())).statusCode).toBe(204);
        expect(connections.http.fetch.mock.calls[0][1].body.get('token')).toBe('access-1');
        expect(await db.get('SELECT COUNT(*) AS n FROM user_connections')).toEqual({ n: 0 });
        connections.http.fetch.mockClear();
        expect((await request(app).delete('/api/user/connections/youtube').set(owner())).statusCode).toBe(204);
        expect(connections.http.fetch).not.toHaveBeenCalled();
    });
});

describe('the server log file', () => {
    let logFile;
    const file = () => path.join(tmp, 'logs', 'server.log');

    beforeEach(() => {
        console.log.mockRestore();
        console.warn.mockRestore();
        // Silence the real console underneath; the log file still gets the lines.
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        logFile = require('../services/logFile');
    });

    afterEach(() => {
        logFile._uninstallForTests();
        console.error.mockRestore();
    });

    it('copies console output to logs/server.log with a time and level', () => {
        expect(logFile.install()).toBe(true);
        expect(logFile.install()).toBe(false); // already installed
        console.log('Server running on %s', 'http://127.0.0.1:3000');
        console.warn('yt-dlp: self-update failed');
        console.error('Failed to start FFmpeg:', 'spawn ffmpeg ENOENT');
        const lines = fs.readFileSync(file(), 'utf8').trim().split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO {2}Server running on http:\/\/127\.0\.0\.1:3000$/);
        expect(lines[1]).toMatch(/ WARN {2}yt-dlp: self-update failed$/);
        expect(lines[2]).toMatch(/ ERROR Failed to start FFmpeg: spawn ffmpeg ENOENT$/);
        expect(logFile.readRecent(2)).toEqual(lines.slice(1));
    });

    it('cuts query strings, tokens and keys, and keeps one record per line', () => {
        logFile.install();
        console.error('yt-dlp said: https://rr3.googlevideo.com/videoplayback?expire=17&sig=AJfQdSsw&ip=203.0.113.9 failed');
        console.error('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature and refresh_token=1//0abcdef client_secret=GOCSPX-abc');
        console.error('first line\n2026-01-01T00:00:00.000Z INFO  forged entry');
        const text = fs.readFileSync(file(), 'utf8');
        for (const secret of ['AJfQdSsw', '203.0.113.9', 'eyJhbGciOiJIUzI1NiJ9', '1//0abcdef', 'GOCSPX-abc']) expect(text).not.toContain(secret);
        expect(text).toContain('https://rr3.googlevideo.com/videoplayback?[cut] failed');
        // The second line of a message is indented: it cannot pass for a record.
        expect(text).toContain('first line\n    2026-01-01T00:00:00.000Z INFO  forged entry\n');
        expect(text.split('\n').filter((line) => /^\d{4}-/.test(line))).toHaveLength(3);
    });

    it('starts a new file at 1 MB and keeps the previous one', () => {
        logFile.install();
        const chunk = 'x'.repeat(3000);
        for (let i = 0; i < 400; i++) console.log(chunk);
        expect(fs.existsSync(`${file()}.1`)).toBe(true);
        expect(fs.statSync(file()).size).toBeLessThanOrEqual(logFile.MAX_BYTES);
        expect(fs.statSync(`${file()}.1`).size).toBeLessThanOrEqual(logFile.MAX_BYTES);
        console.log('last line');
        expect(logFile.readRecent(1)).toEqual([expect.stringMatching(/ INFO {2}last line$/)]);
        expect(logFile.readRecent(5000).length).toBeLessThanOrEqual(1000);
    });

    it('can be turned off, and never throws when the file cannot be written', () => {
        process.env.LOG_FILE = 'off';
        expect(logFile.install()).toBe(false);
        expect(fs.existsSync(file())).toBe(false);
        delete process.env.LOG_FILE;
        logFile.install();
        fs.rmSync(path.join(tmp, 'logs'), { recursive: true, force: true });
        expect(() => console.log('nowhere to write')).not.toThrow();
        expect(logFile.readRecent()).toEqual([]);
    });

    it('hands the end of the log to the owner only, and health says where it is', async () => {
        logFile.install();
        console.error('SoundCloud (yt-dlp): Could not resolve audio source: boom');
        expect((await request(app).get('/api/system/log')).statusCode).toBe(401);
        expect((await request(app).get('/api/system/log').set(other())).statusCode).toBe(403);
        const res = await request(app).get('/api/system/log?lines=50').set(owner());
        expect(res.statusCode).toBe(200);
        expect(res.body.file).toBe('logs/server.log');
        expect(res.body.lines.join('\n')).toContain('Could not resolve audio source: boom');
        expect(JSON.stringify(res.body)).not.toContain(tmp);

        const health = require('../services/health');
        health.runner.version = jest.fn(async () => null);
        const report = await request(app).get('/api/health?fresh=1').set(other());
        expect(report.body).toMatchObject({ status: 'degraded', platform: process.platform, log: { enabled: true, file: 'logs/server.log' } });
        expect(report.body.binaries).toEqual({ ytDlp: { available: false, version: null }, ffmpeg: { available: false, version: null } });
    });
});
