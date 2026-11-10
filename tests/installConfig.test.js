// The installed app: its settings template, and an honest "not configured"
// when no Google credentials are set (instead of a broken Google login).
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

describe('settings template in the data folder', () => {
    it('is created once, owner-only, with empty credential keys', () => {
        const { ensureEnvTemplate } = require('../services/runtimeConfig');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-env-'));
        jest.spyOn(console, 'log').mockImplementation(() => {});
        expect(ensureEnvTemplate(dir)).toBe(true);
        expect(ensureEnvTemplate(dir)).toBe(false); // never overwritten
        console.log.mockRestore();
        const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        expect(text).toMatch(/^GOOGLE_CLIENT_ID=$/m);
        expect(text).toMatch(/^GOOGLE_CLIENT_SECRET=$/m);
        expect(text).toContain('http://localhost:3000/auth/google/callback');
        if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps an existing .env untouched', () => {
        const { ensureEnvTemplate } = require('../services/runtimeConfig');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-env-'));
        fs.writeFileSync(path.join(dir, '.env'), 'GOOGLE_CLIENT_ID=mine\n');
        expect(ensureEnvTemplate(dir)).toBe(false);
        expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('GOOGLE_CLIENT_ID=mine\n');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('YouTube without Google credentials', () => {
    let saved;
    beforeEach(() => {
        saved = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET];
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        jest.resetModules();
    });
    afterEach(() => {
        [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET] = saved;
        jest.resetModules();
    });

    it('is reported as not connectable, and the connect URL answers 503 SOURCE_NOT_CONFIGURED', async () => {
        const app = require('../app');
        app.locals.db = { get: jest.fn().mockResolvedValue({ id: 1 }), all: jest.fn().mockResolvedValue([]), run: jest.fn() };
        const auth = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

        expect(require('../providers/youtube').isAvailable()).toBe(false);
        const res = await request(app).get('/auth/google/url').set(auth);
        expect(res.statusCode).toBe(503);
        expect(res.body).toMatchObject({ code: 'SOURCE_NOT_CONFIGURED', source: 'youtube' });
    });
});
