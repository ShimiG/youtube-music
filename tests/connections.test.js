// Generic token refresh (ROADMAP Stage 3): the server renews expired service
// tokens itself and only reports SOURCE_TOKEN_EXPIRED when renewal fails.
jest.mock('../controllers/youtubeClient', () => ({ getYouTubeClient: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const connections = require('../services/connections');
const { encrypt, decrypt } = require('../services/tokenCrypto');

const authHeader = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

const googleResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock;
let db;

beforeEach(() => {
    fetchMock = jest.fn();
    connections.http.fetch = fetchMock;
    connections._resetInFlight();
    db = { get: jest.fn(), run: jest.fn().mockResolvedValue({}), all: jest.fn() };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => console.warn.mockRestore());

describe('getSourceToken(youtube)', () => {
    it('returns a fresh stored token without calling Google', async () => {
        db.get.mockResolvedValueOnce({ access_token: encrypt('fresh'), refresh_token: encrypt('r'), expires_at: Date.now() + 3600e3 });
        await expect(connections.getSourceToken(db, 1, 'youtube')).resolves.toBe('fresh');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still reads legacy plaintext rows', async () => {
        db.get.mockResolvedValueOnce({ access_token: 'legacy', refresh_token: null, expires_at: Date.now() + 3600e3 });
        await expect(connections.getSourceToken(db, 1, 'youtube')).resolves.toBe('legacy');
    });

    it('refreshes an expired token once for concurrent callers and stores it encrypted, keeping the refresh token', async () => {
        db.get.mockResolvedValue({ access_token: encrypt('old'), refresh_token: encrypt('refresh-1'), expires_at: Date.now() - 1000 });
        fetchMock.mockResolvedValueOnce(googleResponse(200, { access_token: 'new-access', expires_in: 3599 }));

        const results = await Promise.all([1, 2, 3].map(() => connections.getSourceToken(db, 1, 'youtube')));
        expect(results).toEqual(['new-access', 'new-access', 'new-access']);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://oauth2.googleapis.com/token');
        const form = new URLSearchParams(init.body);
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('refresh-1');

        expect(db.run).toHaveBeenCalledTimes(1);
        const params = db.run.mock.calls[0][1];
        expect(params[0]).toBe(1);
        expect(params[1]).toBe(1); // sources.id for youtube
        expect(params[2]).toMatch(/^enc:v1:/);
        expect(decrypt(params[2])).toBe('new-access');
        expect(params[3]).toBeNull(); // COALESCE keeps the stored refresh token
        expect(params[4]).toBeGreaterThan(Date.now());
    });

    it('drops a revoked refresh token (invalid_grant) and reports SOURCE_TOKEN_EXPIRED', async () => {
        db.get.mockResolvedValueOnce({ access_token: encrypt('old'), refresh_token: encrypt('dead'), expires_at: Date.now() - 1000 });
        fetchMock.mockResolvedValueOnce(googleResponse(400, { error: 'invalid_grant' }));

        await expect(connections.getSourceToken(db, 1, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_TOKEN_EXPIRED', source: 'youtube' });
        expect(db.run.mock.calls[0][0]).toContain('SET refresh_token = NULL');
    });

    it('keeps the refresh token on a transient Google failure', async () => {
        db.get.mockResolvedValueOnce({ access_token: encrypt('old'), refresh_token: encrypt('ok'), expires_at: Date.now() - 1000 });
        fetchMock.mockResolvedValueOnce(googleResponse(503, {}));

        await expect(connections.getSourceToken(db, 1, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_TOKEN_EXPIRED' });
        expect(db.run).not.toHaveBeenCalled();
    });

    it('treats an undecryptable token as not connected', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        db.get.mockResolvedValueOnce({ access_token: 'enc:v1:AAAA:BBBB:CCCC', refresh_token: null, expires_at: null });
        await expect(connections.getSourceToken(db, 1, 'youtube')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONNECTED' });
        console.error.mockRestore();
    });
});

describe('route level: an expired YouTube token is renewed transparently', () => {
    it('GET /playlists succeeds after a server-side refresh instead of returning 401', async () => {
        app.locals.db = db;
        db.get.mockResolvedValue({ access_token: encrypt('old'), refresh_token: encrypt('r'), expires_at: Date.now() - 1000 });
        fetchMock.mockResolvedValueOnce(googleResponse(200, { access_token: 'renewed', expires_in: 3600 }));

        const { getYouTubeClient } = require('../controllers/youtubeClient');
        getYouTubeClient.mockReturnValue({
            playlists: { list: jest.fn().mockResolvedValue({ data: { items: [{ id: 'PL1' }] } }) }
        });

        const res = await request(app).get('/playlists').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([{ id: 'PL1' }]);
        expect(getYouTubeClient).toHaveBeenCalledWith('renewed');
    });
});

describe('GET /api/user/connections', () => {
    it('marks YouTube refreshable when a refresh token is stored', async () => {
        app.locals.db = db;
        db.all.mockResolvedValueOnce([{ source_name: 'youtube', expires_at: 1, refreshable: 1 }]);
        const res = await request(app).get('/api/user/connections').set(authHeader);
        expect(res.statusCode).toBe(200);
        expect(db.all.mock.calls[0][0]).toContain("s.name IN ('youtube', 'soundcloud')");
    });
});
