// Hosted, answers are compressed (services/compression.js): the client's
// files once at start-up, JSON as it is sent. Never audio, never on a computer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const compression = require('../services/compression');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// supertest unpacks a compressed body; this asks with plain http and keeps
// the bytes as they were sent. raw(app, 'GET', '/path', { header: value }).
const http = require('http');
function raw(app, method, url, headers = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: url, headers }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => { server.close(); resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
            });
            req.on('error', (err) => { server.close(); reject(err); });
            req.end();
        });
    });
}

describe('which encoding a browser accepts', () => {
    const pick = (header) => compression.chooseEncoding({ headers: header === undefined ? {} : { 'accept-encoding': header } });
    it('prefers brotli, then gzip, and honours "not this one"', () => {
        expect(pick('gzip, deflate, br, zstd')).toBe('br');
        expect(pick('gzip, deflate')).toBe('gzip');
        expect(pick('br;q=0, gzip')).toBe('gzip');
        expect(pick('br;q=0.0,gzip;q=0')).toBeNull();
        expect(pick('identity')).toBeNull();
        expect(pick('')).toBeNull();
        expect(pick(undefined)).toBeNull();
        expect(pick('brotli-ish, xgzip')).toBeNull();
    });
});

describe("the client's files", () => {
    let dir;
    let app;
    const script = `console.log(${JSON.stringify('a song title '.repeat(4000))});`;
    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-assets-'));
        fs.writeFileSync(path.join(dir, 'index-abc123.js'), script);
        fs.writeFileSync(path.join(dir, 'index-def456.css'), 'body{color:red}'.repeat(500));
        fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.alloc(3000, 7));
        app = express();
        app.use('/assets', compression.serveCompressedAssets(dir));
        app.use((req, res) => res.status(404).end());
        await wait(300); // compressed in the background at start-up
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('sends brotli or gzip as the browser accepts, the same bytes once unpacked', async () => {
        const br = await raw(app, 'GET', '/assets/index-abc123.js', { 'Accept-Encoding': 'gzip, br' });
        expect(br.headers['content-encoding']).toBe('br');
        expect(br.headers['content-type']).toBe('text/javascript; charset=utf-8');
        expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(br.headers.vary).toMatch(/Accept-Encoding/);
        expect(br.body.length).toBeLessThan(script.length / 10);
        expect(zlib.brotliDecompressSync(br.body).toString()).toBe(script);

        const gz = await raw(app, 'GET', '/assets/index-def456.css', { 'Accept-Encoding': 'gzip' });
        expect(gz.headers['content-encoding']).toBe('gzip');
        expect(zlib.gunzipSync(gz.body).toString()).toBe('body{color:red}'.repeat(500));

        const plain = await raw(app, 'GET', '/assets/index-abc123.js', { 'Accept-Encoding': 'identity' });
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.body.toString()).toBe(script);
    });

    it('leaves out what is compressed already, and anything not in the folder', async () => {
        const png = await raw(app, 'GET', '/assets/logo.png', { 'Accept-Encoding': 'br' });
        expect(png.statusCode).toBe(404); // not one of the client's text files: not served from here
        expect((await request(app).get('/assets/missing.js')).statusCode).toBe(404);
        expect((await request(app).get('/assets/../index-abc123.js')).statusCode).toBe(404);
        expect((await request(app).post('/assets/index-abc123.js')).statusCode).toBe(404);
    });
});

describe('JSON answers', () => {
    const app = express();
    app.use(compression.compressJson);
    const big = { tracks: Array.from({ length: 200 }, (_, i) => ({ id: `id${i}`, title: `A rather long song title ${i}`, artist: 'Some Artist', source: 'youtube' })) };
    app.get('/big', (req, res) => res.json(big));
    app.get('/small', (req, res) => res.json({ ok: true }));
    app.get('/stream', (req, res) => { res.set('Content-Type', 'audio/mpeg'); res.end(Buffer.alloc(5000, 1)); });
    app.get('/typed', (req, res) => res.type('application/vnd.example+json').json(big));

    it('compresses a large answer, and the browser gets the same object', async () => {
        const res = await raw(app, 'GET', '/big', { 'Accept-Encoding': 'gzip, deflate, br' });
        expect(res.headers['content-encoding']).toBe('br');
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.headers.vary).toMatch(/Accept-Encoding/);
        const text = JSON.stringify(big);
        expect(res.body.length).toBeLessThan(text.length / 5);
        expect(JSON.parse(zlib.brotliDecompressSync(res.body))).toEqual(big);
        const gz = await raw(app, 'GET', '/big', { 'Accept-Encoding': 'gzip' });
        expect(JSON.parse(zlib.gunzipSync(gz.body))).toEqual(big);
        // supertest, like a browser, unpacks it.
        expect((await request(app).get('/big').set('Accept-Encoding', 'gzip')).body).toEqual(big);
    });

    it('keeps a type the route set', async () => {
        const res = await raw(app, 'GET', '/typed', { 'Accept-Encoding': 'br' });
        expect(res.headers['content-type']).toMatch(/^application\/vnd\.example\+json/);
        expect(res.headers['content-encoding']).toBe('br');
    });

    it('leaves small answers, audio, and browsers that do not accept it alone', async () => {
        expect((await raw(app, 'GET', '/small', { 'Accept-Encoding': 'br' })).headers['content-encoding']).toBeUndefined();
        const audio = await raw(app, 'GET', '/stream', { 'Accept-Encoding': 'br' });
        expect(audio.headers['content-encoding']).toBeUndefined();
        expect(audio.body.length).toBe(5000);
        expect((await raw(app, 'GET', '/big', { 'Accept-Encoding': 'identity' })).headers['content-encoding']).toBeUndefined();
    });
});

describe('switched on only where it helps', () => {
    const saved = {};
    const KEYS = ['COMPRESS', 'SERVE_CLIENT'];
    beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
    afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
    const enabled = () => require('../services/hosting').compressionEnabled();

    it('off on a computer, on when hosted, and as told', async () => {
        expect(enabled()).toBe(false);
        process.env.COMPRESS = 'on';
        expect(enabled()).toBe(true);
        process.env.COMPRESS = 'off';
        process.env.SERVE_CLIENT = path.join(__dirname, 'fixtures');
        expect(enabled()).toBe(false);
        jest.resetModules();
        process.env.COMPRESS = '';
        const app = require('../app');
        app.locals.db = { get: async () => null, all: async () => [], run: async () => ({}) };
        // On a computer the API answers as it always did.
        expect((await raw(app, 'GET', '/api/cloud/info', { 'Accept-Encoding': 'br' })).headers['content-encoding']).toBeUndefined();
    });
});
