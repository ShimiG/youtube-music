const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');

// A valid token the app will accept (JWT_SECRET is set in tests/setup.js).
const validToken = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const authHeader = { Authorization: `Bearer ${validToken}` };

describe('Health & routing', () => {
    it('GET / returns 200 JSON status', async () => {
        const res = await request(app).get('/');
        expect(res.statusCode).toBe(200);
        expect(res.header['content-type']).toContain('application/json');
        expect(res.body.status).toBe('Running');
    });

    it('unknown routes return 404 as JSON', async () => {
        const res = await request(app).get('/this-does-not-exist');
        expect(res.statusCode).toBe(404);
        expect(res.body).toHaveProperty('error');
    });
});

describe('Auth is enforced on protected routes', () => {
    it('GET /history with no token returns 401', async () => {
        const res = await request(app).get('/history');
        expect(res.statusCode).toBe(401);
    });

    it('GET /history with a forged/garbage token returns 401', async () => {
        const res = await request(app).get('/history').set('Authorization', 'Bearer not-a-real-token');
        expect(res.statusCode).toBe(401);
    });

    it('POST /api/custom-playlists with no token returns 401', async () => {
        const res = await request(app).post('/api/custom-playlists').send({ name: 'x' });
        expect(res.statusCode).toBe(401);
    });

    it('a client cannot pick its own identity via x-user-id header', async () => {
        // The old design trusted this header. It must now be ignored entirely.
        const res = await request(app).get('/api/custom-playlists').set('x-user-id', '1');
        expect(res.statusCode).toBe(401);
    });

    it('GET /search with no token returns 401 (login required before Google token lookup)', async () => {
        const res = await request(app).get('/search?q=test');
        expect(res.statusCode).toBe(401);
    });

    it('GET /auth/google/url with no token returns 401', async () => {
        const res = await request(app).get('/auth/google/url');
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/user/connections with no token returns 401', async () => {
        const res = await request(app).get('/api/user/connections');
        expect(res.statusCode).toBe(401);
    });
});

describe('Stored Google connection (googleToken middleware)', () => {
    beforeEach(() => {
        app.locals.db = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
    });

    it('returns 401 GOOGLE_NOT_CONNECTED when the user has no stored connection', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/search?q=test').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('GOOGLE_NOT_CONNECTED');
    });

    it('returns 401 GOOGLE_TOKEN_EXPIRED when the stored token is past its expiry', async () => {
        app.locals.db.get.mockResolvedValueOnce({
            access_token: 'stored-google-token',
            expires_at: Date.now() - 1000
        });
        const res = await request(app).get('/search?q=test').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('GOOGLE_TOKEN_EXPIRED');
    });

    it('looks up the connection for the token userId, never client input', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        await request(app).get('/search?q=test').set(authHeader).set('x-user-id', '999');
        expect(app.locals.db.get.mock.calls[0][1][0]).toBe(1);
    });

    it('GET /auth/google/callback without state returns 400', async () => {
        const res = await request(app).get('/auth/google/callback?code=abc');
        expect(res.statusCode).toBe(400);
    });
});

describe('Input validation', () => {
    it('POST /api/login rejects missing credentials with 400', async () => {
        const res = await request(app).post('/api/login').send({});
        expect(res.statusCode).toBe(400);
    });

    it('POST /history with a valid token but no track data returns 400', async () => {
        app.locals.db = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
        const res = await request(app).post('/history').set(authHeader).send({});
        expect(res.statusCode).toBe(400);
    });

    it('GET /stream rejects an invalid videoId with 400', async () => {
        const res = await request(app).get('/stream?videoId=../../etc/passwd');
        expect(res.statusCode).toBe(400);
    });
});
