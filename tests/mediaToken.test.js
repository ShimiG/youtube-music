// Issue #53: /stream and /duration must not be usable by anything but the
// logged-in player. They take a short-lived media token in the URL.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const { issueMediaToken, verifyMediaToken, MEDIA_TOKEN_TTL_SEC } = require('../services/mediaToken');
const { withMedia } = require('./helpers/media');

const session = jwt.sign({ userId: 1, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${session}` };

describe('GET /api/media/token', () => {
    it('requires our login', async () => {
        const res = await request(app).get('/api/media/token');
        expect(res.statusCode).toBe(401);
    });

    it('issues a media token for the logged-in user, not cacheable', async () => {
        const res = await request(app).get('/api/media/token').set(auth);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.expiresAt).toBeGreaterThan(Date.now());
        expect(res.body.expiresAt).toBeLessThanOrEqual(Date.now() + MEDIA_TOKEN_TTL_SEC * 1000 + 1000);
        expect(verifyMediaToken(res.body.token)).toMatchObject({ userId: 1, purpose: 'media' });
    });
});

describe('media routes refuse requests without a valid media token', () => {
    const routes = ['/stream?videoId=dQw4w9WgXcQ', '/duration?videoId=dQw4w9WgXcQ', '/stream?source=soundcloud&videoId=123'];

    it.each(routes)('%s without a token -> 401 MEDIA_TOKEN_REQUIRED', async (url) => {
        const res = await request(app).get(url);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('MEDIA_TOKEN_REQUIRED');
    });

    it('rejects a session (login) token used as a media token', async () => {
        const res = await request(app).get(`/stream?videoId=dQw4w9WgXcQ&t=${session}`);
        expect(res.statusCode).toBe(401);
    });

    it('rejects expired, forged, wrong-algorithm, oversized and non-string tokens', async () => {
        const expired = jwt.sign({ userId: 1, purpose: 'media' }, process.env.JWT_SECRET, { expiresIn: -10 });
        const forged = jwt.sign({ userId: 1, purpose: 'media' }, 'some-other-secret-some-other-secret', { expiresIn: '1h' });
        const hs512 = jwt.sign({ userId: 1, purpose: 'media' }, process.env.JWT_SECRET, { algorithm: 'HS512', expiresIn: '1h' });
        const noExp = jwt.sign({ userId: 1, purpose: 'media' }, process.env.JWT_SECRET);
        const badUser = jwt.sign({ userId: 'x', purpose: 'media' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        for (const t of [expired, forged, hs512, noExp, badUser, 'a'.repeat(5000), '']) {
            const res = await request(app).get(`/stream?videoId=dQw4w9WgXcQ&t=${t}`);
            expect(res.statusCode).toBe(401);
        }
        const arr = await request(app).get(`/stream?videoId=dQw4w9WgXcQ&t=a&t=b`);
        expect(arr.statusCode).toBe(401);
    });

    it('checks the token before anything else (an invalid id without a token is 401, not 400)', async () => {
        const res = await request(app).get('/stream?videoId=../../etc/passwd');
        expect(res.statusCode).toBe(401);
    });

    it('with a valid token the request reaches validation', async () => {
        const res = await request(app).get(withMedia('/stream?videoId=../../etc/passwd'));
        expect(res.statusCode).toBe(400);
    });
});

describe('a media token is not a login', () => {
    it('is rejected by routes that need a session', async () => {
        const { token } = issueMediaToken(1);
        const res = await request(app).get('/api/user/connections').set('Authorization', `Bearer ${token}`);
        expect(res.statusCode).toBe(401);
        const again = await request(app).get('/api/media/token').set('Authorization', `Bearer ${token}`);
        expect(again.statusCode).toBe(401); // cannot be used to mint new tokens either
    });
});
