// Route-level tests for the SoundCloud endpoints wired in app.js.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const client = require('../controllers/soundcloud/client');
const tokens = require('../controllers/soundcloud/tokens');
const soundcloudController = require('../controllers/soundcloudController');
const ytdlp = require('../controllers/soundcloud/ytdlp');

const validToken = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const authHeader = { Authorization: `Bearer ${validToken}` };

const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
});

let fetchMock;
let ytdlpExec;

beforeEach(() => {
    process.env.SOUNDCLOUD_CLIENT_ID = 'test-client-id';
    process.env.SOUNDCLOUD_CLIENT_SECRET = 'test-client-secret';
    process.env.SOUNDCLOUD_PROVIDER = 'auto';
    ytdlpExec = jest.fn();
    ytdlp.runner.exec = ytdlpExec;
    fetchMock = jest.fn();
    client.http.fetch = fetchMock;
    client.http.sleep = jest.fn().mockResolvedValue(undefined);
    tokens._resetCaches();
    soundcloudController._pendingFlows.clear();
    app.locals.db = { get: jest.fn(), run: jest.fn().mockResolvedValue({}), all: jest.fn() };
});

describe('Auth is enforced', () => {
    it('GET /auth/soundcloud/url without our login returns 401', async () => {
        const res = await request(app).get('/auth/soundcloud/url');
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/soundcloud/search without our login returns 401', async () => {
        const res = await request(app).get('/api/soundcloud/search?q=test');
        expect(res.statusCode).toBe(401);
    });

    it('GET /api/soundcloud/playlists without our login returns 401', async () => {
        const res = await request(app).get('/api/soundcloud/playlists');
        expect(res.statusCode).toBe(401);
    });
});

describe('Connect flow', () => {
    it('returns 503 SOUNDCLOUD_NOT_CONFIGURED when credentials are missing', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        app.locals.db.get.mockResolvedValue({ id: 1 }); // the session's user exists
        const res = await request(app).get('/auth/soundcloud/url').set(authHeader);
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('SOUNDCLOUD_NOT_CONFIGURED');
    });

    it('issues a PKCE authorize URL and keeps the verifier server-side', async () => {
        app.locals.db.get.mockResolvedValue({ id: 1 }); // the session's user exists
        const res = await request(app).get('/auth/soundcloud/url').set(authHeader);
        expect(res.statusCode).toBe(200);

        const url = new URL(res.body.url);
        expect(url.origin).toBe('https://secure.soundcloud.com');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        const state = url.searchParams.get('state');
        expect(state).toMatch(/^[a-f0-9]{48}$/);

        // The verifier must not be discoverable from the URL.
        expect(res.body.url).not.toContain(soundcloudController._pendingFlows.get(state).verifier);
        expect(soundcloudController._pendingFlows.get(state).userId).toBe(1);
    });

    it('GET /auth/soundcloud/callback without state returns 400', async () => {
        const res = await request(app).get('/auth/soundcloud/callback?code=abc');
        expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown state and never calls the token endpoint', async () => {
        const res = await request(app).get('/auth/soundcloud/callback?code=abc&state=forged');
        expect(res.statusCode).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exchanges the code with the stored verifier, saves tokens for the state owner, and consumes the state', async () => {
        app.locals.db.get.mockResolvedValue({ id: 1 }); // the session's user exists
        const urlRes = await request(app).get('/auth/soundcloud/url').set(authHeader);
        const state = new URL(urlRes.body.url).searchParams.get('state');
        const verifier = soundcloudController._pendingFlows.get(state).verifier;

        fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'sc-access', refresh_token: 'sc-refresh', expires_in: 3600 }));

        const res = await request(app).get(`/auth/soundcloud/callback?code=the-code&state=${state}`);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toMatch(/#soundcloud=connected&expires_at=\d+$/);

        const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
        expect(form.get('code_verifier')).toBe(verifier);
        expect(form.get('code')).toBe('the-code');

        // Stored against userId 1 (from the state), source 3 (soundcloud).
        const [, params] = app.locals.db.run.mock.calls[0];
        expect(params.slice(0, 4)).toEqual([1, 3, 'sc-access', 'sc-refresh']);

        // Replaying the same state must fail.
        const replay = await request(app).get(`/auth/soundcloud/callback?code=the-code&state=${state}`);
        expect(replay.statusCode).toBe(400);
    });

    it('GET /auth/soundcloud/url returns 401 USER_NOT_FOUND when the session names a deleted account', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined); // no users row for this id
        const res = await request(app).get('/auth/soundcloud/url').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('USER_NOT_FOUND');
        // Nothing was minted, so nothing can be replayed later.
        expect(soundcloudController._pendingFlows.size).toBe(0);
    });

    it('callback redirects with reason=user_not_found instead of hitting the FOREIGN KEY when the user is gone', async () => {
        app.locals.db.get.mockResolvedValueOnce({ id: 1 }); // url step: user exists
        const urlRes = await request(app).get('/auth/soundcloud/url').set(authHeader);
        const state = new URL(urlRes.body.url).searchParams.get('state');

        fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: 'sc-access', refresh_token: 'sc-refresh', expires_in: 3600 }));
        app.locals.db.get.mockResolvedValueOnce(undefined); // callback step: user deleted meanwhile

        const res = await request(app).get(`/auth/soundcloud/callback?code=the-code&state=${state}`);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('soundcloud=error&reason=user_not_found');
        // The INSERT that used to throw SQLITE_CONSTRAINT: FOREIGN KEY is never reached.
        expect(app.locals.db.run).not.toHaveBeenCalled();
    });
});

describe('Search', () => {
    it('rejects an empty query with 400', async () => {
        const res = await request(app).get('/api/soundcloud/search?q=').set(authHeader);
        expect(res.statusCode).toBe(400);
    });

    it('searches with the app token when the user has no connection and returns normalised items', async () => {
        app.locals.db.get
            .mockResolvedValueOnce(undefined)   // user_connections lookup: not connected
            .mockResolvedValueOnce(undefined);  // app_tokens lookup: none cached
        fetchMock
            .mockResolvedValueOnce(jsonResponse(200, { access_token: 'app-tok', refresh_token: 'app-ref', expires_in: 3600 }))
            .mockResolvedValueOnce(jsonResponse(200, {
                collection: [{ urn: 'soundcloud:tracks:11', title: 'A', duration: 1000, access: 'playable', user: { username: 'u' } }],
                next_href: 'https://api.soundcloud.com/tracks?cursor=next'
            }));

        const res = await request(app).get('/api/soundcloud/search?q=hello').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(res.body.items).toEqual([expect.objectContaining({ id: '11', source: 'soundcloud', title: 'A', duration: 1 })]);
        expect(res.body.nextCursor).toBe('https://api.soundcloud.com/tracks?cursor=next');

        const searchUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(searchUrl.pathname).toBe('/tracks');
        expect(searchUrl.searchParams.get('q')).toBe('hello');
        expect(searchUrl.searchParams.get('access')).toBe('playable,preview');
        expect(searchUrl.searchParams.get('linked_partitioning')).toBe('true');
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('OAuth app-tok');
    });

    it('rejects a cursor that points off the API host', async () => {
        app.locals.db.get.mockResolvedValue({ access_token: 'user-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        const res = await request(app)
            .get(`/api/soundcloud/search?q=x&cursor=${encodeURIComponent('https://evil.example.com/tracks')}`)
            .set(authHeader);
        expect(res.statusCode).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a 429 from SoundCloud as 429 with a clear code when yt-dlp fallback is off', async () => {
        // In `auto` mode a 429 falls back to yt-dlp (covered below); force the API
        // path here to check the rate limit itself is reported clearly.
        process.env.SOUNDCLOUD_PROVIDER = 'api';
        app.locals.db.get.mockResolvedValue({ access_token: 'user-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        const limited = jsonResponse(429, { errors: [{ meta: { rate_limit: { group: 'plays' }, reset_time: '2026/09/16 00:00:00 +0000' } }] });
        fetchMock.mockResolvedValue(limited);

        const res = await request(app).get('/api/soundcloud/search?q=x').set(authHeader);
        expect(res.statusCode).toBe(429);
        expect(res.body.code).toBe('SOUNDCLOUD_RATE_LIMITED');
        expect(res.body.resetTime).toBe('2026/09/16 00:00:00 +0000');
    });
});

describe('Library (soundcloudToken middleware)', () => {
    it('returns 401 SOUNDCLOUD_NOT_CONNECTED when the user has no stored connection', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/api/soundcloud/playlists').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('SOUNDCLOUD_NOT_CONNECTED');
    });

    it('returns 401 SOUNDCLOUD_TOKEN_EXPIRED when expired and there is no refresh token', async () => {
        app.locals.db.get.mockResolvedValueOnce({ access_token: 'old', refresh_token: null, expires_at: Date.now() - 1000 });
        const res = await request(app).get('/api/soundcloud/playlists').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('SOUNDCLOUD_TOKEN_EXPIRED');
    });

    it('lists /me/playlists with the user token and pins the virtual Liked playlist first', async () => {
        app.locals.db.get.mockResolvedValueOnce({ access_token: 'user-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { collection: [{ urn: 'soundcloud:playlists:5', title: 'Mix', track_count: 3 }] }));

        const res = await request(app).get('/api/soundcloud/playlists').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(res.body[0]).toMatchObject({ id: 'liked', kind: 'liked' });
        expect(res.body[1]).toMatchObject({ id: '5', title: 'Mix', itemCount: 3 });

        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.pathname).toBe('/me/playlists');
        expect(url.searchParams.get('show_tracks')).toBe('false');
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('OAuth user-tok');
    });

    it('routes the liked playlist to /me/likes/tracks and real ids to /playlists/{urn}/tracks', async () => {
        app.locals.db.get.mockResolvedValue({ access_token: 'user-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        fetchMock.mockResolvedValue(jsonResponse(200, { collection: [] }));

        await request(app).get('/api/soundcloud/playlists/liked/tracks').set(authHeader);
        expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/me/likes/tracks');

        await request(app).get('/api/soundcloud/playlists/77/tracks').set(authHeader);
        expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe('/playlists/soundcloud:playlists:77/tracks');

        const bad = await request(app).get('/api/soundcloud/playlists/not-an-id/tracks').set(authHeader);
        expect(bad.statusCode).toBe(400);
    });
});

describe('Playback routing', () => {
    it('GET /stream with an unknown source returns 400', async () => {
        const res = await request(app).get('/stream?videoId=123&source=napster');
        expect(res.statusCode).toBe(400);
    });

    it('GET /stream?source=soundcloud rejects a non-numeric id', async () => {
        const res = await request(app).get('/stream?videoId=dQw4w9WgXcQ&source=soundcloud');
        expect(res.statusCode).toBe(400);
    });

    it('GET /stream?source=soundcloud returns 404 for a blocked track', async () => {
        app.locals.db.get.mockResolvedValueOnce({ access_token: 'app-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

        const res = await request(app).get('/stream?videoId=123456&source=soundcloud');
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('SOUNDCLOUD_BLOCKED');
        expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/tracks/soundcloud:tracks:123456/streams');
    });

    it('GET /duration?source=soundcloud returns the track duration in seconds', async () => {
        app.locals.db.get.mockResolvedValueOnce({ access_token: 'app-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { urn: 'soundcloud:tracks:999', duration: 183000 }));

        const res = await request(app).get('/duration?videoId=999&source=soundcloud');
        expect(res.statusCode).toBe(200);
        expect(res.body.duration).toBe(183);
    });

    it('GET /stream without a source still routes to YouTube and validates the 11-char id', async () => {
        const res = await request(app).get('/stream?videoId=short');
        expect(res.statusCode).toBe(400);
    });
});

describe('History accepts a source', () => {
    it('records a SoundCloud play against the soundcloud source', async () => {
        app.locals.db.get
            .mockResolvedValueOnce({ id: 3 })    // sources lookup
            .mockResolvedValueOnce({ id: 50 });  // track lookup

        const res = await request(app).post('/history').set(authHeader)
            .send({ trackId: '123', title: 'T', artist: 'A', source: 'soundcloud' });

        expect(res.statusCode).toBe(200);
        expect(app.locals.db.get.mock.calls[0][1]).toEqual(['soundcloud']);
    });

    it('rejects a malformed source', async () => {
        const res = await request(app).post('/history').set(authHeader)
            .send({ trackId: '123', title: 'T', source: 'sound cloud; DROP' });
        expect(res.statusCode).toBe(400);
    });
});

describe('yt-dlp fallback (no credentials or API trouble)', () => {
    const flatLine = (id, title, duration = 200) => JSON.stringify({ id, title, uploader: 'u', duration, webpage_url: `https://soundcloud.com/u/${id}`, thumbnails: [] });

    it('GET /api/soundcloud/status reports the yt-dlp provider and no connect when unconfigured', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        const res = await request(app).get('/api/soundcloud/status').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ provider: 'ytdlp', apiConfigured: false, connectAvailable: false, searchAvailable: true, libraryAvailable: false });
    });

    it('GET /api/soundcloud/status reports the API provider when configured', async () => {
        const res = await request(app).get('/api/soundcloud/status').set(authHeader);
        expect(res.body).toMatchObject({ provider: 'api', connectAvailable: true });
    });

    it('searches through yt-dlp when no credentials are configured, without touching the token endpoint', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        ytdlpExec.mockResolvedValueOnce([flatLine('1', 'One'), flatLine('2', 'Two', 30)].join('\n'));

        const res = await request(app).get('/api/soundcloud/search?q=hello').set(authHeader);

        expect(res.statusCode).toBe(200);
        expect(res.body.provider).toBe('ytdlp');
        expect(res.body.nextCursor).toBeNull();
        expect(res.body.items.map(t => t.id)).toEqual(['1', '2']);
        expect(res.body.items[1].preview).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ytdlpExec.mock.calls[0][0].pop()).toBe('scsearch30:hello');
    });

    it('falls back to yt-dlp when the official API is rate limited', async () => {
        app.locals.db.get.mockResolvedValue({ access_token: 'user-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        fetchMock.mockResolvedValue(jsonResponse(429, { errors: [{ meta: { reset_time: 'later' } }] }));
        ytdlpExec.mockResolvedValueOnce(flatLine('7', 'Seven'));

        const res = await request(app).get('/api/soundcloud/search?q=x').set(authHeader);

        expect(res.statusCode).toBe(200);
        expect(res.body.provider).toBe('ytdlp');
        expect(res.body.items[0].id).toBe('7');
    });

    it('does not fall back when SOUNDCLOUD_PROVIDER=api is forced', async () => {
        process.env.SOUNDCLOUD_PROVIDER = 'api';
        app.locals.db.get.mockResolvedValue({ access_token: 'user-tok', refresh_token: 'r', expires_at: Date.now() + 600000 });
        fetchMock.mockResolvedValue(jsonResponse(429, {}));

        const res = await request(app).get('/api/soundcloud/search?q=x').set(authHeader);

        expect(res.statusCode).toBe(429);
        expect(ytdlpExec).not.toHaveBeenCalled();
    });

    it('uses yt-dlp for search even with credentials when SOUNDCLOUD_PROVIDER=ytdlp', async () => {
        process.env.SOUNDCLOUD_PROVIDER = 'ytdlp';
        ytdlpExec.mockResolvedValueOnce(flatLine('3', 'Three'));

        const res = await request(app).get('/api/soundcloud/search?q=x').set(authHeader);

        expect(res.statusCode).toBe(200);
        expect(res.body.provider).toBe('ytdlp');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves the stream through yt-dlp when unconfigured and reports a blocked track as 404', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        ytdlpExec.mockResolvedValueOnce('\n'); // no URL

        const res = await request(app).get('/stream?videoId=123456&source=soundcloud');

        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('SOUNDCLOUD_BLOCKED');
        expect(ytdlpExec.mock.calls[0][0].pop()).toBe('https://api.soundcloud.com/tracks/123456');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers /duration through yt-dlp when unconfigured', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        ytdlpExec.mockResolvedValueOnce('183.4\n');

        const res = await request(app).get('/duration?videoId=4242&source=soundcloud');

        expect(res.statusCode).toBe(200);
        expect(res.body.duration).toBe(183);
    });

    it('surfaces a yt-dlp failure as 502 with its own code', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        const err = new Error('yt-dlp failed: ERROR: boom');
        err.code = 'YTDLP_FAILED';
        ytdlpExec.mockRejectedValueOnce(err);

        const res = await request(app).get('/api/soundcloud/search?q=x').set(authHeader);

        expect(res.statusCode).toBe(502);
        expect(res.body.code).toBe('SOUNDCLOUD_YTDLP_FAILED');
    });

    it('library routes stay API-only: unconfigured server returns 401 not-connected, never spawns yt-dlp', async () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/api/soundcloud/playlists').set(authHeader);
        expect(res.statusCode).toBe(401);
        expect(ytdlpExec).not.toHaveBeenCalled();
    });
});
