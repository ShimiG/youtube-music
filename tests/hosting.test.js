// Running as a website (render.yaml, services/hosting.js): the server serves
// the built client from its own address, accepts that address as an origin,
// sits behind a proxy, and has no "Local Files".
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const KEYS = ['SERVE_CLIENT', 'PUBLIC_URL', 'RENDER_EXTERNAL_URL', 'TRUST_PROXY', 'LOCAL_FILES', 'CLIENT_ORIGIN'];
let saved;
let dist;
const auth = { Authorization: `Bearer ${jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

function load(env) {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    jest.resetModules();
    const app = require('../app');
    app.locals.db = { get: jest.fn(async () => null), all: jest.fn(async () => []), run: jest.fn(async () => ({})), transaction: (fn) => fn() };
    return app;
}

beforeAll(() => {
    // A built client, as `vite build` leaves it.
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Music</title><script type="module" src="/assets/index-abc.js"></script>');
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log("app")');
    fs.writeFileSync(path.join(dist, 'vite.svg'), '<svg/>');
    fs.writeFileSync(path.join(dist, '.env'), 'SECRET=1');
});
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

describe('on a computer (nothing set)', () => {
    it('answers / with JSON and serves no client files', async () => {
        const app = load({});
        const res = await request(app).get('/');
        expect(res.body).toMatchObject({ status: 'Running' });
        expect((await request(app).get('/assets/index-abc.js')).statusCode).toBe(404);
    });

    it('keeps Local Files', async () => {
        const app = load({});
        expect((await request(app).get('/api/local/folders').set(auth)).statusCode).not.toBe(404);
        expect((await request(app).get('/api/sources').set(auth)).body.sources.map((x) => x.name)).toContain('local');
    });
});

describe('hosted', () => {
    const site = 'https://music-manager.onrender.com';
    const hosted = (extra = {}) => load({ SERVE_CLIENT: dist, RENDER_EXTERNAL_URL: site, TRUST_PROXY: '1', LOCAL_FILES: 'off', ...extra });

    it('serves the client at /, its files, and nothing else from the folder', async () => {
        const app = hosted();
        const page = await request(app).get('/');
        expect(page.statusCode).toBe(200);
        expect(page.headers['content-type']).toMatch(/text\/html/);
        expect(page.text).toContain('<title>Music</title>');
        expect(page.headers['cache-control']).toBe('no-cache');
        const script = await request(app).get('/assets/index-abc.js');
        expect(script.statusCode).toBe(200);
        expect(script.headers['cache-control']).toMatch(/immutable/);
        expect((await request(app).get('/vite.svg')).statusCode).toBe(200);
        expect((await request(app).get('/.env')).statusCode).toBe(404);
        expect((await request(app).get('/assets/../index.html')).statusCode).not.toBe(500);
        // The API is where it was.
        expect((await request(app).get('/api/cloud/info')).statusCode).toBe(200);
    });

    it('lets the page show covers from the services and play audio from this address, and nothing more', async () => {
        const csp = (await request(hosted()).get('/')).headers['content-security-policy'];
        expect(csp).toContain("img-src 'self' data: blob: https:");
        expect(csp).toContain("media-src 'self' blob:");
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    });

    it("accepts the site's own address as an origin (a POST from its pages sends it), and no other", async () => {
        const app = hosted();
        const own = await request(app).post('/api/cloud/login').set('Origin', site).send({});
        expect(own.headers['access-control-allow-origin']).toBe(site);
        expect(own.statusCode).not.toBe(500);
        const other = await request(app).post('/api/cloud/login').set('Origin', 'https://evil.example').send({});
        expect(other.statusCode).toBe(403); // refused by the CORS check
        expect(other.headers['access-control-allow-origin']).toBeUndefined();
        // PUBLIC_URL wins over Render's own variable; a bad value is ignored.
        expect((await request(hosted({ PUBLIC_URL: 'https://music.example.org/' })).post('/api/cloud/login').set('Origin', 'https://music.example.org').send({})).headers['access-control-allow-origin']).toBe('https://music.example.org');
        expect(require('../services/hosting').publicUrl()).toBe('https://music.example.org');
        process.env.PUBLIC_URL = 'javascript:alert(1)';
        process.env.RENDER_EXTERNAL_URL = '';
        expect(require('../services/hosting').publicUrl()).toBeNull();
    });

    it('sends the browser back to the site after a sign-in', () => {
        hosted();
        expect(require('../services/oauthReturn').clientOrigin()).toBe(site);
        process.env.CLIENT_ORIGIN = 'https://chosen.example';
        expect(require('../services/oauthReturn').clientOrigin()).toBe('https://chosen.example');
    });

    it('counts each visitor behind the proxy, not the proxy', async () => {
        const app = hosted();
        expect(app.get('trust proxy')).toBe(1);
        expect(load({ TRUST_PROXY: '' }).get('trust proxy')).toBe(false);
        expect(load({ TRUST_PROXY: '2' }).get('trust proxy')).toBe(2);
    });

    it('has no Local Files: the routes answer 404 and the source is not offered', async () => {
        const app = hosted();
        const res = await request(app).post('/api/local/folders').set(auth).send({ path: '/opt/render' });
        expect(res).toMatchObject({ statusCode: 404, body: { code: 'LOCAL_FILES_OFF' } });
        expect(require('../providers/local').isAvailable()).toBe(false);
        const sources = (await request(app).get('/api/sources').set(auth)).body.sources.map((x) => x.name);
        expect(sources).not.toContain('local');
        expect(sources).toContain('youtube');
    });

    it('falls back to the plain API when the client was not built', async () => {
        const app = load({ SERVE_CLIENT: path.join(dist, 'missing') });
        expect((await request(app).get('/')).body).toMatchObject({ status: 'Running' });
    });
});
