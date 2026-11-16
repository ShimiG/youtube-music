// Security review 2026-11-16, cloud-url-no-ssrf-guard: the cloud service's
// address comes from a person, so the server must not be made to call this
// computer, a private network or a metadata address through it
// (services/cloud/client.js, services/netGuard.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const httpServer = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const netGuard = require('../services/netGuard');

let dir;
let db;
let app;
let client;
let sync;
let server;      // a real HTTP server on this computer: the thing that must not be reachable
let port;
let hits;

const session = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });

const PRIVATE = [
    'https://127.0.0.1', 'https://127.8.9.10:8443', 'https://localhost', 'https://app.localhost', 'https://LOCALHOST',
    'https://10.1.2.3', 'https://172.16.0.9', 'https://192.168.1.5', 'https://169.254.169.254', 'https://100.64.0.1', 'https://0.0.0.0',
    'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fd00::1]', 'https://[fe80::1]'
];

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-guard-'));
    delete process.env.CLOUD_URL;
    delete process.env.CLOUD_ALLOW_LOCAL;
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    app = require('../app');
    client = require('../services/cloud/client');
    sync = require('../services/cloud/sync');
    db = await require('../config/db')(path.join(dir, 'database.sqlite'));
    app.locals.db = db;

    hits = [];
    server = httpServer.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            hits.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
            if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${port}/health` }); return res.end(); }
            if (req.url === '/text') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>a router login page</h1>'); }
            if (req.url === '/big') { res.writeHead(200); return res.end(Buffer.alloc(client.MAX_RESPONSE_BYTES + 1024, 0x20)); }
            if (req.url === '/refused') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ code: 'NOT_SIGNED_IN', error: 'Sign in first.' })); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, service: 'music-manager-cloud', registrationOpen: false }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

afterEach(async () => {
    sync._reset();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    console.log.mockRestore();
    delete process.env.CLOUD_ALLOW_LOCAL;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('addresses that are refused as written', () => {
    it('this computer, private networks and the metadata address are not accepted as a cloud address', () => {
        for (const url of [...PRIVATE, `http://127.0.0.1:${port}`, 'http://localhost:8787']) {
            expect(() => client.normalizeUrl(url)).toThrow(expect.objectContaining({ code: 'BAD_URL', status: 400 }));
        }
        expect(client.normalizeUrl('https://music-manager-cloud.me.workers.dev')).toBe('https://music-manager-cloud.me.workers.dev');
        expect(client.normalizeUrl('https://8.8.8.8')).toBe('https://8.8.8.8');
    });

    it('nothing is sent to one that is already in use (saved by an older version, or CLOUD_URL)', async () => {
        client.http.fetch = jest.fn();
        for (const url of PRIVATE) {
            await expect(client.request(url, '/health')).rejects.toMatchObject({ code: 'BAD_URL' });
        }
        await expect(client.request(`http://127.0.0.1:${port}`, '/auth/login', { method: 'POST', body: { a: 1 } })).rejects.toMatchObject({ code: 'BAD_URL' });
        expect(client.http.fetch).not.toHaveBeenCalled();
        expect(hits).toEqual([]);
    });

    it('the reported request: the owner pointing the server at a port on this computer', async () => {
        await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'owner', 'x')`);
        const res = await request(app).put('/api/cloud/url').set(session(1)).send({ url: `http://127.0.0.1:${port}` });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('CLOUD_BAD_URL');
        const metadata = await request(app).put('/api/cloud/url').set(session(1)).send({ url: 'https://169.254.169.254' });
        expect(metadata.statusCode).toBe(400);
        expect(metadata.body.error).toMatch(/private network/);
        // Refused before any connection: the server on that port saw nothing.
        expect(hits).toEqual([]);
        expect((await sync.cloudUrl(db)).url).toBeNull();
    });

    it('the same through the login screen of a computer with no accounts, which needs no login at all', async () => {
        for (const url of [`http://127.0.0.1:${port}`, 'https://192.168.1.1', 'https://169.254.169.254']) {
            const res = await request(app).post('/api/cloud/login').send({ username: 'Shimi', password: 'correct horse', url });
            expect(res.statusCode).toBe(400);
            expect(res.body.code).toBe('CLOUD_BAD_URL');
        }
        expect(hits).toEqual([]);
        expect((await db.get('SELECT COUNT(*) AS n FROM users')).n).toBe(0);
        expect((await request(app).get('/api/cloud/info')).body).toEqual({ configured: false, canSetAddress: true });
    });
});

describe('a name that leads to a private address', () => {
    it('is refused when the socket looks it up, so the check and the connection cannot disagree', async () => {
        const answers = {
            'looks-public.example': [{ address: '127.0.0.1', family: 4 }],
            'two-faced.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
            'nowhere.example': []
        };
        client.http.dnsLookup = jest.fn((hostname, options, callback) => callback(null, answers[hostname]));
        for (const host of Object.keys(answers)) {
            // The name passes the first look: there is nothing private about it as written.
            expect(client.normalizeUrl(`https://${host}:${port}`)).toBe(`https://${host}:${port}`);
            await expect(client.request(`https://${host}:${port}`, '/health')).rejects.toMatchObject({ code: 'UNREACHABLE' });
        }
        expect(client.http.dnsLookup).toHaveBeenCalledTimes(3);
        expect(hits).toEqual([]);

        // Through the route: the same answer as any address that does not respond,
        // so it cannot be used to find out what is listening where.
        await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'owner', 'x')`);
        const res = await request(app).put('/api/cloud/url').set(session(1)).send({ url: `https://looks-public.example:${port}` });
        expect(res.statusCode).toBe(502);
        expect(res.body.code).toBe('CLOUD_UNREACHABLE');
        expect(hits).toEqual([]);
    });

    it('the look-up itself: public addresses pass, anything else does not', () => {
        const run = (addresses, options = {}) => new Promise((resolve) => {
            const lookup = netGuard.guardedLookup({
                lookup: (hostname, opts, callback) => (addresses instanceof Error ? callback(addresses) : callback(null, addresses)),
                blockedError: () => new Error('blocked')
            });
            lookup('host.example', options, (err, address, family) => resolve(err ? err.message : [address, family]));
        });
        const pub = { address: '93.184.216.34', family: 4 };
        return Promise.all([
            run([pub]), run([pub], { all: true }), run([pub, { address: '10.0.0.1', family: 4 }]),
            run([{ address: '::ffff:10.0.0.1', family: 6 }]), run([]), run(new Error('ENOTFOUND'))
        ]).then((results) => {
            expect(results).toEqual([['93.184.216.34', 4], [[pub], undefined], 'blocked', 'blocked', 'blocked', 'ENOTFOUND']);
        });
    });
});

describe('with CLOUD_ALLOW_LOCAL (a Worker on this computer, for development)', () => {
    beforeEach(() => { process.env.CLOUD_ALLOW_LOCAL = '1'; });

    it('a local address works, over the real connection', async () => {
        const base = client.normalizeUrl(`http://127.0.0.1:${port}`);
        expect(await client.request(base, '/health')).toMatchObject({ ok: true, service: 'music-manager-cloud' });
        await client.request(base, '/sync/push', { method: 'POST', token: 'session-token', body: { changes: [1, 2] } });
        expect(hits[1]).toEqual({ method: 'POST', url: '/sync/push', auth: 'Bearer session-token', body: '{"changes":[1,2]}' });
        // And the owner can save it.
        await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'owner', 'x')`);
        const res = await request(app).put('/api/cloud/url').set(session(1)).send({ url: `http://localhost:${port}` });
        expect(res.statusCode).toBe(200);
        expect(res.body.url).toBe(`http://localhost:${port}`);
    });

    it('still follows no redirect, reads no page as an answer, and takes only so much', async () => {
        const base = `http://127.0.0.1:${port}`;
        await expect(client.request(base, '/redirect', { token: 'secret-session' })).rejects.toMatchObject({ code: 'BAD_RESPONSE', status: 302 });
        expect(hits.map((h) => h.url)).toEqual(['/redirect']); // the token went nowhere else
        await expect(client.request(base, '/text')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
        await expect(client.request(base, '/big')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
        await expect(client.request(base, '/refused')).rejects.toMatchObject({ code: 'NOT_SIGNED_IN', status: 401 });
        // Nothing listening: unreachable, like any other failure to connect.
        await new Promise((resolve) => server.close(resolve));
        await expect(client.request(base, '/health')).rejects.toMatchObject({ code: 'UNREACHABLE' });
        server.listen(0, '127.0.0.1');
    });

    it('only when it is switched on: 0, false and nothing mean off', () => {
        for (const value of ['0', 'false', 'no', '', undefined]) {
            if (value === undefined) delete process.env.CLOUD_ALLOW_LOCAL; else process.env.CLOUD_ALLOW_LOCAL = value;
            expect(client.allowLocal()).toBe(false);
            expect(() => client.normalizeUrl('http://localhost:8787')).toThrow(expect.objectContaining({ code: 'BAD_URL' }));
        }
        for (const value of ['1', 'true', 'YES', 'on']) {
            process.env.CLOUD_ALLOW_LOCAL = value;
            expect(client.allowLocal()).toBe(true);
        }
    });
});
