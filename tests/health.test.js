const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const health = require('../services/health');

const authHeader = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

beforeEach(() => health._resetMemo());

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
            ytDlp: { available: true, version: '2026.10.01' },
            ffmpeg: { available: true, version: '6.1.1-static' }
        });
        expect(res.body.cache).toHaveProperty('maxBytes');
        expect(JSON.stringify(res.body)).not.toMatch(/[\\/]bin[\\/]|node_modules/);
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
