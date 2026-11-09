// OAuth flows end either in the web client (redirect to CLIENT_ORIGIN) or in
// the desktop app (musicmanager:// deep link). The target is fixed when the
// flow starts and carried in the signed state, so a callback can't be pointed
// anywhere else.
const mockGetToken = jest.fn();
jest.mock('@googleapis/youtube', () => ({
    auth: {
        OAuth2: jest.fn().mockImplementation(() => ({
            generateAuthUrl: ({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
            getToken: mockGetToken
        }))
    },
    youtube: jest.fn()
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const client = require('../controllers/soundcloud/client');
const soundcloudController = require('../controllers/soundcloudController');
const { parseReturnTarget } = require('../services/oauthReturn');

const authHeader = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };
const stateFrom = (url) => new URL(url).searchParams.get('state');

beforeEach(() => {
    app.locals.db = {
        get: jest.fn().mockResolvedValue({ id: 1, refresh_token: 'enc:v1:x' }),
        run: jest.fn().mockResolvedValue({}),
        all: jest.fn()
    };
    mockGetToken.mockReset();
    soundcloudController._pendingFlows.clear();
});

describe('parseReturnTarget', () => {
    it('only ever yields "app" or "web"', () => {
        expect(parseReturnTarget('app')).toBe('app');
        for (const v of [undefined, '', 'web', 'APP', 'https://evil.example', 'musicmanager://x', ['app']]) {
            expect(parseReturnTarget(v)).toBe('web');
        }
    });
});

describe('Google connect flow', () => {
    it('web flow (default) redirects back to CLIENT_ORIGIN as before', async () => {
        const urlRes = await request(app).get('/auth/google/url').set(authHeader);
        mockGetToken.mockResolvedValueOnce({ tokens: { access_token: 'a', refresh_token: 'r', expiry_date: 123 } });
        const res = await request(app).get(`/auth/google/callback?code=c&state=${stateFrom(urlRes.body.url)}`);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('http://localhost:5173/#google=connected&expires_at=123&refreshable=1');
    });

    it('?return=app is signed into the state and ends in a musicmanager:// deep link page', async () => {
        const urlRes = await request(app).get('/auth/google/url?return=app').set(authHeader);
        const state = stateFrom(urlRes.body.url);
        expect(jwt.decode(state)).toMatchObject({ ret: 'app', purpose: 'google_oauth' });

        mockGetToken.mockResolvedValueOnce({ tokens: { access_token: 'a', refresh_token: 'r', expiry_date: 123 } });
        const res = await request(app).get(`/auth/google/callback?code=c&state=${state}`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain('content="0;url=musicmanager://oauth#google=connected&amp;expires_at=123&amp;refreshable=1"');
        expect(res.text).toContain('Account connected');
        expect(res.headers['cache-control']).toBe('no-store');
    });

    it('an unknown return value falls back to the web client (no open redirect)', async () => {
        const urlRes = await request(app).get('/auth/google/url?return=https://evil.example').set(authHeader);
        expect(jwt.decode(stateFrom(urlRes.body.url)).ret).toBe('web');
    });

    it('errors in an app flow are also handed to the app', async () => {
        const urlRes = await request(app).get('/auth/google/url?return=app').set(authHeader);
        mockGetToken.mockRejectedValueOnce(new Error('bad code'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app).get(`/auth/google/callback?code=c&state=${stateFrom(urlRes.body.url)}`);
        console.error.mockRestore();
        expect(res.text).toContain('musicmanager://oauth#google=error&amp;reason=token_exchange');
        expect(res.text).toContain('Connection failed');
    });
});

describe('SoundCloud connect flow', () => {
    beforeEach(() => {
        process.env.SOUNDCLOUD_CLIENT_ID = 'id';
        process.env.SOUNDCLOUD_CLIENT_SECRET = 'secret';
        client.http.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, headers: { get: () => null },
            text: async () => JSON.stringify({ access_token: 'sc', refresh_token: 'scr', expires_in: 3600 })
        });
    });

    it('stores the return target with the pending flow and ends in the app', async () => {
        const urlRes = await request(app).get('/auth/soundcloud/url?return=app').set(authHeader);
        const state = stateFrom(urlRes.body.url);
        expect(soundcloudController._pendingFlows.get(state).ret).toBe('app');

        const res = await request(app).get(`/auth/soundcloud/callback?code=c&state=${state}`);
        expect(res.statusCode).toBe(200);
        expect(res.text).toMatch(/url=musicmanager:\/\/oauth#soundcloud=connected&amp;expires_at=\d+"/);
    });

    it('a denied consent in an app flow returns to the app', async () => {
        const urlRes = await request(app).get('/auth/soundcloud/url?return=app').set(authHeader);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app).get(`/auth/soundcloud/callback?error=access_denied&state=${stateFrom(urlRes.body.url)}`);
        console.error.mockRestore();
        expect(res.text).toContain('musicmanager://oauth#soundcloud=error');
    });

    it('web flow still redirects to CLIENT_ORIGIN', async () => {
        const urlRes = await request(app).get('/auth/soundcloud/url').set(authHeader);
        const res = await request(app).get(`/auth/soundcloud/callback?code=c&state=${stateFrom(urlRes.body.url)}`);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toMatch(/^http:\/\/localhost:5173\/#soundcloud=connected/);
    });
});

describe('CORS', () => {
    it('allows the Tauri v2 Windows origin', async () => {
        const res = await request(app).get('/').set('Origin', 'http://tauri.localhost');
        expect(res.headers['access-control-allow-origin']).toBe('http://tauri.localhost');
    });
});
