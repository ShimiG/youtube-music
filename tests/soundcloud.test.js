// Unit tests for the SoundCloud client + token layer. The network is stubbed
// through client.http so nothing here touches api.soundcloud.com.
const crypto = require('crypto');
const client = require('../controllers/soundcloud/client');
const tokens = require('../controllers/soundcloud/tokens');

const jsonResponse = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body))
});

const tokenBody = (suffix, extra = {}) => ({
    access_token: `access-${suffix}`,
    refresh_token: `refresh-${suffix}`,
    expires_in: 3600,
    scope: '',
    ...extra
});

let fetchMock;
let sleepMock;

beforeEach(() => {
    process.env.SOUNDCLOUD_CLIENT_ID = 'test-client-id';
    process.env.SOUNDCLOUD_CLIENT_SECRET = 'test-client-secret';
    process.env.SOUNDCLOUD_REDIRECT_URI = 'http://localhost:3000/auth/soundcloud/callback';
    fetchMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);
    client.http.fetch = fetchMock;
    client.http.sleep = sleepMock;
    tokens._resetCaches();
});

describe('PKCE and authorize URL', () => {
    it('generates an S256 challenge that matches the verifier', () => {
        const { verifier, challenge } = client.generatePkce();
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        const expected = crypto.createHash('sha256').update(verifier).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(challenge).toBe(expected);
    });

    it('builds the authorize URL on secure.soundcloud.com with the documented parameters', () => {
        const url = new URL(client.buildAuthorizeUrl({ state: 'abc', codeChallenge: 'xyz' }));
        expect(url.origin + url.pathname).toBe('https://secure.soundcloud.com/authorize');
        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/soundcloud/callback');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('code_challenge')).toBe('xyz');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('state')).toBe('abc');
    });

    it('refuses to build a URL when credentials are missing', () => {
        delete process.env.SOUNDCLOUD_CLIENT_ID;
        expect(client.isConfigured()).toBe(false);
        expect(() => client.buildAuthorizeUrl({ state: 'a', codeChallenge: 'b' })).toThrow(/not configured/);
    });
});

describe('Token endpoint calls', () => {
    it('exchanges a code with grant_type=authorization_code, verifier and matching redirect_uri', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, tokenBody('user')));

        const result = await client.exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://secure.soundcloud.com/oauth/token');
        expect(init.method).toBe('POST');
        expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        const form = new URLSearchParams(init.body);
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code')).toBe('the-code');
        expect(form.get('code_verifier')).toBe('the-verifier');
        expect(form.get('redirect_uri')).toBe('http://localhost:3000/auth/soundcloud/callback');
        expect(form.get('client_id')).toBe('test-client-id');
        expect(form.get('client_secret')).toBe('test-client-secret');

        expect(result.accessToken).toBe('access-user');
        expect(result.refreshToken).toBe('refresh-user');
        expect(result.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);
    });

    it('requests client_credentials with HTTP Basic auth only (no secret in the body)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, tokenBody('app')));

        await client.fetchClientCredentialsToken();

        const [, init] = fetchMock.mock.calls[0];
        const expectedBasic = `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`;
        expect(init.headers.Authorization).toBe(expectedBasic);
        const form = new URLSearchParams(init.body);
        expect(form.get('grant_type')).toBe('client_credentials');
        expect(form.has('client_secret')).toBe(false);
    });

    it('surfaces a token error with its status instead of retrying', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
        await expect(client.refreshAccessToken('dead')).rejects.toMatchObject({ status: 400, code: 'invalid_grant' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('apiRequest', () => {
    it('sends Authorization: OAuth <token> to api.soundcloud.com', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { urn: 'soundcloud:tracks:1' }));

        await client.apiRequest('/tracks/soundcloud:tracks:1', { token: 'tok' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.soundcloud.com/tracks/soundcloud:tracks:1');
        expect(init.headers.Authorization).toBe('OAuth tok');
        expect(init.headers.Authorization.startsWith('Bearer')).toBe(false);
    });

    it('backs off exponentially on 429 and then surfaces the error with reset time', async () => {
        const limited = {
            errors: [{ meta: { rate_limit: { group: 'plays', max_nr_of_requests: 15000, time_window: 'PT24H' }, remaining_requests: 0, reset_time: '2026/09/16 09:49:40 +0000' } }]
        };
        fetchMock
            .mockResolvedValueOnce(jsonResponse(429, limited))
            .mockResolvedValueOnce(jsonResponse(429, limited))
            .mockResolvedValueOnce(jsonResponse(429, limited));

        await expect(client.apiRequest('/tracks/soundcloud:tracks:1/streams', { token: 'tok' }))
            .rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', resetTime: '2026/09/16 09:49:40 +0000' });

        // 1 initial + 2 retries, with growing delays between them.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleepMock).toHaveBeenCalledTimes(2);
        const [first, second] = sleepMock.mock.calls.map(c => c[0]);
        expect(first).toBeGreaterThanOrEqual(500);
        expect(second).toBeGreaterThan(first);
    });

    it('honours Retry-After when it is short', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': '2' }))
            .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

        const result = await client.apiRequest('/tracks', { token: 'tok' });
        expect(result).toEqual({ ok: true });
        expect(sleepMock).toHaveBeenCalledWith(2000);
    });

    it('does not retry a 4xx that is not a rate limit', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(404, { code: 404, message: '404 - Not Found' }));
        await expect(client.apiRequest('/tracks/soundcloud:tracks:9', { token: 'tok' })).rejects.toMatchObject({ status: 404 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).not.toHaveBeenCalled();
    });

    it('refuses to follow a cursor that points outside the API host', async () => {
        await expect(client.apiRequest('https://evil.example.com/tracks', { token: 'tok' }))
            .rejects.toMatchObject({ code: 'BAD_CURSOR' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('fetchCollection pagination', () => {
    it('requests linked_partitioning=true and follows next_href until absent', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(200, { collection: [{ id: 1 }, { id: 2 }], next_href: 'https://api.soundcloud.com/me/likes/tracks?cursor=abc&limit=2' }))
            .mockResolvedValueOnce(jsonResponse(200, { collection: [{ id: 3 }] }));

        const { items, nextHref } = await client.fetchCollection('/me/likes/tracks', { token: 'tok', query: { limit: 2 }, maxPages: 5 });

        expect(items.map(i => i.id)).toEqual([1, 2, 3]);
        expect(nextHref).toBeNull();
        const firstUrl = new URL(fetchMock.mock.calls[0][0]);
        expect(firstUrl.searchParams.get('linked_partitioning')).toBe('true');
        expect(firstUrl.searchParams.get('limit')).toBe('2');
        expect(fetchMock.mock.calls[1][0]).toBe('https://api.soundcloud.com/me/likes/tracks?cursor=abc&limit=2');
    });

    it('stops at maxPages and returns the remaining cursor', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { collection: [{ id: 1 }], next_href: 'https://api.soundcloud.com/tracks?cursor=n' }));

        const { items, nextHref } = await client.fetchCollection('/tracks', { token: 'tok', query: { q: 'x' }, maxPages: 1 });

        expect(items).toHaveLength(1);
        expect(nextHref).toBe('https://api.soundcloud.com/tracks?cursor=n');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('accepts a legacy bare-array response', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, [{ id: 7 }]));
        const { items, nextHref } = await client.fetchCollection('/tracks', { token: 'tok' });
        expect(items).toEqual([{ id: 7 }]);
        expect(nextHref).toBeNull();
    });
});

describe('Normalisation', () => {
    const raw = {
        urn: 'soundcloud:tracks:308946187',
        title: 'Night Drive',
        duration: 245678,
        artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
        permalink_url: 'https://soundcloud.com/someone/night-drive',
        access: 'preview',
        user: { username: 'someone', avatar_url: 'https://i1.sndcdn.com/avatars-x-large.jpg', permalink_url: 'https://soundcloud.com/someone' }
    };

    it('maps a track to the shared shape, marking preview access', () => {
        const t = client.normalizeTrack(raw);
        expect(t).toMatchObject({
            id: '308946187',
            source: 'soundcloud',
            title: 'Night Drive',
            channelTitle: 'someone',
            duration: 246,
            access: 'preview',
            preview: true,
            playable: true,
            permalinkUrl: 'https://soundcloud.com/someone/night-drive'
        });
        expect(t.thumbnail).toBe('https://i1.sndcdn.com/artworks-abc-t300x300.jpg');
    });

    it('prefers metadata_artist, flags blocked tracks and falls back to the avatar', () => {
        const t = client.normalizeTrack({ id: 42, title: 'X', access: 'blocked', metadata_artist: 'Real Artist', user: { username: 'uploader', avatar_url: 'https://i1.sndcdn.com/avatars-x-large.jpg' } });
        expect(t.id).toBe('42');
        expect(t.channelTitle).toBe('Real Artist');
        expect(t.playable).toBe(false);
        expect(t.preview).toBe(false);
        expect(t.thumbnail).toBe('https://i1.sndcdn.com/avatars-x-t300x300.jpg');
    });

    it('maps a playlist', () => {
        const p = client.normalizePlaylist({ urn: 'soundcloud:playlists:1212781357', title: 'Mix', track_count: 12, artwork_url: null, permalink_url: 'https://soundcloud.com/u/sets/mix' });
        expect(p).toMatchObject({ id: '1212781357', source: 'soundcloud', kind: 'playlist', title: 'Mix', itemCount: 12, readOnly: true });
    });

    it('validates ids and rebuilds URNs', () => {
        expect(client.isValidId('123')).toBe(true);
        expect(client.isValidId('../etc')).toBe(false);
        expect(client.isValidId('soundcloud:tracks:1')).toBe(false);
        expect(client.toTrackUrn('5')).toBe('soundcloud:tracks:5');
        expect(client.idFromUrn('soundcloud:users:948745750')).toBe('948745750');
    });

    it('picks a full stream before a preview and reports which it chose', () => {
        expect(client.pickStreamUrl({ hls_mp3_128_url: 'a', hls_aac_160_url: 'b', preview_mp3_128_url: 'c' })).toMatchObject({ url: 'a', isPreview: false });
        expect(client.pickStreamUrl({ hls_aac_160_url: 'b', preview_mp3_128_url: 'c' })).toMatchObject({ url: 'b', isPreview: false });
        expect(client.pickStreamUrl({ preview_mp3_128_url: 'c' })).toMatchObject({ url: 'c', isPreview: true });
        expect(client.pickStreamUrl({})).toBeNull();
    });
});

describe('App token cache (client_credentials)', () => {
    const makeDb = (row) => ({
        get: jest.fn().mockResolvedValue(row),
        run: jest.fn().mockResolvedValue({}),
        all: jest.fn()
    });

    it('reuses a fresh token from the database without calling the token endpoint', async () => {
        const db = makeDb({ access_token: 'db-token', refresh_token: 'db-refresh', expires_at: Date.now() + 30 * 60 * 1000 });
        const token = await tokens.getAppToken(db);
        expect(token).toBe('db-token');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('performs exactly one exchange for many concurrent callers and caches it', async () => {
        const db = makeDb(undefined);
        fetchMock.mockResolvedValueOnce(jsonResponse(200, tokenBody('app')));

        const results = await Promise.all([tokens.getAppToken(db), tokens.getAppToken(db), tokens.getAppToken(db)]);
        expect(results).toEqual(['access-app', 'access-app', 'access-app']);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Subsequent calls hit the in-memory copy.
        await tokens.getAppToken(db);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(db.run).toHaveBeenCalledTimes(1);
        expect(db.run.mock.calls[0][1]).toEqual(['soundcloud', 'access-app', 'refresh-app', expect.any(Number)]);
    });

    it('renews an expired app token with the refresh_token grant rather than a new client_credentials exchange', async () => {
        const db = makeDb({ access_token: 'old', refresh_token: 'old-refresh', expires_at: Date.now() - 1000 });
        fetchMock.mockResolvedValueOnce(jsonResponse(200, tokenBody('renewed')));

        const token = await tokens.getAppToken(db);
        expect(token).toBe('access-renewed');

        const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('old-refresh');
        // The single-use refresh token was replaced in the database.
        expect(db.run.mock.calls[0][1][2]).toBe('refresh-renewed');
    });

    it('falls back to one client_credentials exchange when the refresh token is rejected, without looping', async () => {
        const db = makeDb({ access_token: 'old', refresh_token: 'spent', expires_at: Date.now() - 1000 });
        fetchMock
            .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }))
            .mockResolvedValueOnce(jsonResponse(200, tokenBody('fresh')));

        const token = await tokens.getAppToken(db);
        expect(token).toBe('access-fresh');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const secondForm = new URLSearchParams(fetchMock.mock.calls[1][1].body);
        expect(secondForm.get('grant_type')).toBe('client_credentials');
    });
});

describe('User token refresh', () => {
    it('returns the stored token while it is fresh', async () => {
        const db = { get: jest.fn().mockResolvedValue({ access_token: 'u', refresh_token: 'r', expires_at: Date.now() + 10 * 60 * 1000 }), run: jest.fn() };
        expect(await tokens.getUserToken(db, 1)).toBe('u');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes a stale token once for concurrent callers and stores the new refresh token', async () => {
        const db = {
            get: jest.fn().mockResolvedValue({ access_token: 'stale', refresh_token: 'r1', expires_at: Date.now() - 5000 }),
            run: jest.fn().mockResolvedValue({})
        };
        fetchMock.mockResolvedValueOnce(jsonResponse(200, tokenBody('u2')));

        const [a, b] = await Promise.all([tokens.getUserToken(db, 7), tokens.getUserToken(db, 7)]);
        expect(a).toBe('access-u2');
        expect(b).toBe('access-u2');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(db.run).toHaveBeenCalledTimes(1);
        expect(db.run.mock.calls[0][1]).toEqual([7, 3, 'access-u2', 'refresh-u2', expect.any(Number)]);
    });

    it('reports SOUNDCLOUD_TOKEN_EXPIRED and drops the dead refresh token when the refresh fails', async () => {
        const db = {
            get: jest.fn().mockResolvedValue({ access_token: 'stale', refresh_token: 'dead', expires_at: Date.now() - 5000 }),
            run: jest.fn().mockResolvedValue({})
        };
        fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_grant' }));

        await expect(tokens.getUserToken(db, 7)).rejects.toMatchObject({ code: 'SOUNDCLOUD_TOKEN_EXPIRED' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(db.run.mock.calls[0][0]).toMatch(/SET refresh_token = NULL/);
    });

    it('reports SOUNDCLOUD_NOT_CONNECTED when there is no row', async () => {
        const db = { get: jest.fn().mockResolvedValue(undefined), run: jest.fn() };
        await expect(tokens.getUserToken(db, 1)).rejects.toMatchObject({ code: 'SOUNDCLOUD_NOT_CONNECTED' });
    });
});
