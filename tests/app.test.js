const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const { withMedia } = require('./helpers/media');

// A valid token the app will accept (JWT_SECRET is set in tests/setup.js).
const validToken = jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' });
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

describe("Stored Google connection (sourceToken('youtube') middleware)", () => {
    beforeEach(() => {
        app.locals.db = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
    });

    it('returns 401 SOURCE_NOT_CONNECTED (source youtube) when the user has no stored connection', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/search?q=test').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
        expect(res.body.source).toBe('youtube');
    });

    it('returns 401 SOURCE_TOKEN_EXPIRED when the stored token is expired and there is no refresh token', async () => {
        app.locals.db.get.mockResolvedValueOnce({
            access_token: 'stored-google-token',
            expires_at: Date.now() - 1000
        });
        const res = await request(app).get('/search?q=test').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('SOURCE_TOKEN_EXPIRED');
        expect(res.body.source).toBe('youtube');
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
    it('POST /api/cloud/login rejects missing credentials with 400', async () => {
        const res = await request(app).post('/api/cloud/login').send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('CLOUD_BAD_INPUT');
    });

    it('POST /history with a valid token but no track data returns 400', async () => {
        app.locals.db = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
        const res = await request(app).post('/history').set(authHeader).send({});
        expect(res.statusCode).toBe(400);
    });

    it('GET /stream rejects an invalid videoId with 400', async () => {
        const res = await request(app).get(withMedia('/stream?videoId=../../etc/passwd'));
        expect(res.statusCode).toBe(400);
    });
});

describe('Connect flow guards against stale sessions', () => {
    // A validly signed JWT whose user row was deleted (or that was issued against
    // a different copy of the database) used to reach the provider callback and
    // die on SQLITE_CONSTRAINT: FOREIGN KEY. It must now fail fast at the URL step.
    beforeEach(() => {
        app.locals.db = { get: jest.fn(), run: jest.fn(), all: jest.fn() };
    });

    it('GET /auth/google/url returns 401 USER_NOT_FOUND when the session names a deleted account', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/auth/google/url').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('USER_NOT_FOUND');
    });

    it('GET /auth/google/url issues a consent URL when the user exists', async () => {
        app.locals.db.get.mockResolvedValueOnce({ id: 1 });
        const res = await request(app).get('/auth/google/url').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(typeof res.body.url).toBe('string');
        expect(res.body.url).toContain('accounts.google.com');
    });
});

describe('Session token hardening', () => {
    beforeEach(() => {
        app.locals.db = { get: jest.fn(), run: jest.fn(), all: jest.fn().mockResolvedValue([]) };
    });

    it('rejects the Google OAuth state token as a session', async () => {
        const state = jwt.sign({ userId: 1, purpose: 'google_oauth' }, process.env.JWT_SECRET, { expiresIn: '10m' });
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${state}`);
        expect(res.statusCode).toBe(401);
    });

    it('rejects an alg=none token', async () => {
        const none = jwt.sign({ userId: 1, purpose: 'session' }, null, { algorithm: 'none' });
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${none}`);
        expect(res.statusCode).toBe(401);
    });

    // Security review 2026-11-16, generic-error-handler-masks-status-codes.
    it('answers a request it cannot read with the client\'s own status, and says nothing about the inside', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const big = await request(app).post('/api/cloud/login').send({ username: 'someone', password: 'x'.repeat(2 * 1024 * 1024) });
        expect(big.statusCode).toBe(413);
        expect(big.body).toEqual({ error: 'Request body too large.' });

        const broken = await request(app).post('/api/cloud/login').set('Content-Type', 'application/json').send('{"username": "a", ');
        expect(broken.statusCode).toBe(400);
        expect(broken.body).toEqual({ error: 'Malformed request.' });
        expect(JSON.stringify(broken.body)).not.toMatch(/JSON|position|Unexpected|at /);
        // Not logged as a failure of the server.
        expect(error).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(([line]) => line)).toEqual([
            expect.stringMatching(/^Rejected request: POST \/api\/cloud\/login \(413, entity\.too\.large\)$/),
            expect.stringMatching(/^Rejected request: POST \/api\/cloud\/login \(400, entity\.parse\.failed\)$/)
        ]);
        warn.mockRestore();
        error.mockRestore();
    });

    it('still answers 500, with no detail, for a failure of its own, whatever status that error carries', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        // An internal error that happens to have a 4xx status and a message: neither reaches the client.
        const inner = Object.assign(new Error('SELECT secret FROM users failed at /home/me/app.js'), { status: 404 });
        app.locals.db = { all: jest.fn().mockRejectedValue(inner), get: jest.fn(), run: jest.fn() };
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${validToken}`);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    it('rejects a token without a valid numeric userId', async () => {
        const bad = jwt.sign({ userId: '1 OR 1=1', purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${bad}`);
        expect(res.statusCode).toBe(401);
    });

    // Tokens from before the `purpose` field were accepted until 16 Nov 2026;
    // sessions last 7 days, so none of them is still valid.
    it('accepts a session token, and nothing that does not say it is one', async () => {
        const call = (payload) => request(app).get('/api/user/connections')
            .set('Authorization', `Bearer ${jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
        expect((await call({ userId: 1, purpose: 'session' })).statusCode).toBe(200);
        for (const payload of [{ userId: 1 }, { userId: 1, purpose: 'media' }, { userId: 1, purpose: 'google_oauth' }, { userId: 1, purpose: '' }, { userId: 1, purpose: null }, { userId: 1, purpose: ['session'] }]) {
            expect((await call(payload)).statusCode).toBe(401);
        }
    });

    it('the tokens the app itself hands out at login and registration are sessions', async () => {
        const { issueToken } = require('../controllers/UserController');
        expect(jwt.verify(issueToken(7), process.env.JWT_SECRET)).toMatchObject({ userId: 7, purpose: 'session', exp: expect.any(Number) });
    });
});
