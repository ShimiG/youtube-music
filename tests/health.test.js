const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const health = require('../services/health');

const authHeader = { Authorization: `Bearer ${jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

const otherHeader = { Authorization: `Bearer ${jwt.sign({ userId: 2, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

beforeEach(() => {
    health._resetMemo();
    // Account 1 is the first on the installation, so it is the owner.
    app.locals.db = { get: jest.fn().mockResolvedValue({ id: 1 }) };
});

describe('GET /api/health', () => {
    it('requires our login', async () => {
        const res = await request(app).get('/api/health');
        expect(res.statusCode).toBe(401);
    });

    it('reports app and binary versions without leaking paths', async () => {
        health.runner.version = jest.fn()
            .mockResolvedValueOnce('2026.10.01')
            .mockResolvedValueOnce('ffmpeg version 6.1.1-static https://johnvansickle.com/ffmpeg/');
        const res = await request(app).get('/api/health').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.version).toBe(require('../package.json').version);
        expect(res.body.binaries).toEqual({
            // startMs: how long yt-dlp itself takes to start (shown in Settings -> System).
            ytDlp: { available: true, version: '2026.10.01', startMs: expect.any(Number) },
            ffmpeg: { available: true, version: '6.1.1-static' }
        });
        expect(res.body.cache).toHaveProperty('maxBytes');
        expect(JSON.stringify(res.body)).not.toMatch(/[\\/]bin[\\/]|node_modules/);
    });

    // Security review 2026-11-16, health-endpoint-any-authenticated-user.
    it('gives the exact versions to the owner only; every account still learns what was found', async () => {
        health.runner.version = jest.fn()
            .mockResolvedValueOnce('2026.10.01')
            .mockResolvedValueOnce('ffmpeg version 6.1.1-static https://johnvansickle.com/ffmpeg/');
        const owner = (await request(app).get('/api/health').set(authHeader)).body;
        const other = (await request(app).get('/api/health').set(otherHeader)).body;
        expect(owner.node).toBe(process.version);
        expect(other.node).toBeNull();
        expect(other.binaries).toEqual({
            ytDlp: { available: true, version: null, startMs: expect.any(Number) },
            ffmpeg: { available: true, version: null }
        });
        expect(JSON.stringify(other)).not.toMatch(/2026\.10\.01|6\.1\.1/);
        // The rest is what Settings -> System and the "nothing can play" message need.
        for (const key of ['status', 'version', 'platform', 'cache', 'log', 'uptimeSec']) expect(other[key]).toEqual(owner[key] === undefined ? undefined : expect.anything());
        expect(other.status).toBe('ok');

        // Who the owner is cannot be told (no database): nobody gets versions.
        app.locals.db = undefined;
        const unknown = (await request(app).get('/api/health').set(authHeader)).body;
        expect(unknown.binaries.ytDlp).toMatchObject({ available: true, version: null });
    });

    it('is degraded (not failing) when a binary is missing', async () => {
        health.runner.version = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('ffmpeg version 6');
        const res = await request(app).get('/api/health').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('degraded');
        expect(res.body.binaries.ytDlp).toEqual({ available: false, version: null });
    });

    it('memoises the probe between calls', async () => {
        health.runner.version = jest.fn().mockResolvedValue('x');
        await request(app).get('/api/health').set(authHeader);
        await request(app).get('/api/health').set(authHeader);
        expect(health.runner.version).toHaveBeenCalledTimes(2); // one per binary, once
    });
});
