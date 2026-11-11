// Deezer (ROADMAP Stage 6, issue #38): catalog search with no account; on play,
// the full track via a YouTube match, else Deezer's 30 s preview. Responses are
// shaped after real Deezer API responses (as recorded in deezer-python's test
// cassettes): search { data, total, next }, track { ..., isrc, contributors },
// errors as HTTP 200 { error: { type, message, code } }.
const mockStreamTranscoded = jest.fn();
jest.mock('../controllers/transcode', () => ({
    ...jest.requireActual('../controllers/transcode'),
    serveFromCache: () => false,
    streamTranscoded: (...args) => mockStreamTranscoded(...args)
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const deezer = require('../providers/deezer');
const matcher = require('../services/matcher');
const YouTubeController = require('../controllers/YouTubeController');
const { withMedia } = require('./helpers/media');

const auth = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

const dzTrack = (over = {}) => ({
    id: 3135556,
    readable: true,
    title: 'Harder Better Faster Stronger',
    isrc: 'GBDUW0000059',
    link: 'https://www.deezer.com/track/3135556',
    duration: 224,
    preview: 'https://cdns-preview-d.dzcdn.net/stream/c-deda7fa9316d9e9e880d2c6207e92260-5.mp3',
    artist: { id: 27, name: 'Daft Punk' },
    album: { id: 302127, title: 'Discovery', cover_medium: 'https://e-cdns-images.dzcdn.net/images/cover/2e018122cb56986277102d2041a592c8/250x250-000000-80-0-0.jpg' },
    contributors: [{ id: 27, name: 'Daft Punk' }],
    ...over
});
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock;
let resolveSpy;
let streamVideoSpy;
let durationSpy;
beforeEach(() => {
    fetchMock = jest.fn();
    deezer.http.fetch = fetchMock;
    deezer._resetForTests();
    mockStreamTranscoded.mockReset();
    mockStreamTranscoded.mockImplementation((req, res) => res.status(200).end());
    resolveSpy = jest.spyOn(matcher, 'resolve');
    streamVideoSpy = jest.spyOn(YouTubeController, 'streamVideo').mockImplementation((req, res) => res.status(200).end());
    durationSpy = jest.spyOn(YouTubeController, 'durationOf').mockResolvedValue(226);
    app.locals.db = { get: jest.fn(), all: jest.fn().mockResolvedValue([]), run: jest.fn() };
});
afterEach(() => jest.restoreAllMocks());

describe('normalisation', () => {
    it('maps a Deezer track to the shared Track shape', () => {
        expect(deezer.toTrack(dzTrack())).toMatchObject({
            source: 'deezer', id: '3135556', title: 'Harder Better Faster Stronger', artist: 'Daft Punk',
            album: 'Discovery', durationSec: 224, isrc: 'GBDUW0000059', playable: true, verifyDuration: true,
            thumbnail: expect.stringMatching(/^https:\/\/e-cdns-images\.dzcdn\.net\//),
            permalinkUrl: 'https://www.deezer.com/track/3135556'
        });
    });

    it('marks unreadable tracks and drops non-https art and foreign links', () => {
        const t = deezer.toTrack(dzTrack({ readable: false, album: { cover_medium: 'http://x/a.jpg' }, link: 'https://evil.example/t' }));
        expect(t).toMatchObject({ playable: false, thumbnail: null, permalinkUrl: null });
    });

    it('gives the match engine the ISRC, artists and duration', () => {
        expect(deezer.matchInput(dzTrack({ contributors: [{ name: 'Daft Punk' }, { name: 'Guest' }] }))).toEqual({
            source: 'deezer', id: '3135556', title: 'Harder Better Faster Stronger', artist: 'Daft Punk',
            artists: ['Daft Punk', 'Guest'], album: 'Discovery', durationSec: 224, isrc: 'GBDUW0000059'
        });
    });
});

describe('GET /api/search/deezer', () => {
    it('searches without a connection, shows results at once and pages by index', async () => {
        const data = Array.from({ length: 30 }, (_, i) => dzTrack({ id: 100 + i }));
        fetchMock.mockResolvedValueOnce(json(200, { data, total: 298, next: 'https://api.deezer.com/search?q=x&index=30' }));
        const res = await request(app).get('/api/search/deezer?q=daft punk').set(auth);
        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(30);
        expect(res.body.nextCursor).toBe('30');
        expect(resolveSpy).not.toHaveBeenCalled(); // no matching while searching
        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://api.deezer.com/search');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: 'daft punk', index: '0', limit: '30' });

        fetchMock.mockResolvedValueOnce(json(200, { data: [dzTrack()], total: 31 }));
        const last = await request(app).get('/api/search/deezer?q=daft punk&cursor=30').set(auth);
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('index')).toBe('30');
        expect(last.body.nextCursor).toBeNull();
    });

    it("maps Deezer's in-body errors: quota -> 429, others -> 502", async () => {
        fetchMock.mockResolvedValueOnce(json(200, { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }));
        expect((await request(app).get('/api/search/deezer?q=x').set(auth)).statusCode).toBe(429);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        fetchMock.mockResolvedValueOnce(json(200, { error: { type: 'SomethingWrong', code: 100 } }));
        expect((await request(app).get('/api/search/deezer?q=x').set(auth)).statusCode).toBe(502);
    });

    it('rejects a bad cursor', async () => {
        expect((await request(app).get('/api/search/deezer?q=x&cursor=abc').set(auth)).statusCode).toBe(400);
    });
});

describe('GET /api/sources', () => {
    it('lists Deezer as searchable without a connection and with no library', async () => {
        const res = await request(app).get('/api/sources').set(auth);
        expect(res.body.sources.find((s) => s.name === 'deezer')).toMatchObject({
            label: 'Deezer', connected: true, searchRequiresConnection: false,
            capabilities: { search: true, playlists: false, stream: true }
        });
    });
});

describe('/stream?source=deezer', () => {
    it('plays the full track from YouTube when the match engine finds it', async () => {
        fetchMock.mockResolvedValueOnce(json(200, dzTrack()));
        resolveSpy.mockResolvedValueOnce({ status: 'matched', videoId: 'gAjR4_CbPpQ', score: 98, method: 'ytmusic' });
        const res = await request(app).get(withMedia('/stream?source=deezer&videoId=3135556'));
        expect(res.statusCode).toBe(200);
        expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/track/3135556');
        expect(resolveSpy.mock.calls[0][1]).toMatchObject({ source: 'deezer', id: '3135556', isrc: 'GBDUW0000059' });
        expect(streamVideoSpy.mock.calls[0][2]).toBe('gAjR4_CbPpQ');
        expect(mockStreamTranscoded).not.toHaveBeenCalled();
    });

    it('plays the 30 s preview, uncached, when there is no match', async () => {
        fetchMock.mockResolvedValueOnce(json(200, dzTrack()));
        resolveSpy.mockResolvedValueOnce({ status: 'not_found', videoId: null });
        await request(app).get(withMedia('/stream?source=deezer&videoId=3135556'));
        expect(streamVideoSpy).not.toHaveBeenCalled();
        expect(mockStreamTranscoded.mock.calls[0][2]).toMatchObject({
            sourceUrl: dzTrack().preview, cacheKey: 'deezer_3135556', allowCache: false
        });
    });

    it('falls back to the preview when matching itself fails', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockResolvedValueOnce(json(200, dzTrack()));
        resolveSpy.mockRejectedValueOnce(new Error('innertube blocked'));
        await request(app).get(withMedia('/stream?source=deezer&videoId=3135556'));
        expect(mockStreamTranscoded).toHaveBeenCalledTimes(1);
    });

    it('answers TRACK_UNAVAILABLE with neither a match nor a playable preview', async () => {
        fetchMock.mockResolvedValueOnce(json(200, dzTrack({ readable: false })));
        resolveSpy.mockResolvedValueOnce({ status: 'not_found', videoId: null });
        const res = await request(app).get(withMedia('/stream?source=deezer&videoId=3135556'));
        expect(res.statusCode).toBe(404);
        expect(res.body).toMatchObject({ code: 'TRACK_UNAVAILABLE', source: 'deezer' });
    });

    it('answers TRACK_UNAVAILABLE for a track Deezer does not know (error 800)', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { error: { type: 'DataException', message: 'no data', code: 800 } }));
        const res = await request(app).get(withMedia('/stream?source=deezer&videoId=999'));
        expect(res.statusCode).toBe(404);
        expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('validates the id and requires a media token, before any request', async () => {
        expect((await request(app).get(withMedia('/stream?source=deezer&videoId=12ab'))).statusCode).toBe(400);
        expect((await request(app).get('/stream?source=deezer&videoId=3135556')).statusCode).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('/duration?source=deezer', () => {
    it('reports the matched video length for a full play', async () => {
        fetchMock.mockResolvedValueOnce(json(200, dzTrack()));
        resolveSpy.mockResolvedValueOnce({ status: 'matched', videoId: 'gAjR4_CbPpQ' });
        const res = await request(app).get(withMedia('/duration?source=deezer&videoId=3135556'));
        expect(res.body).toEqual({ duration: 226, preview: false });
        expect(durationSpy.mock.calls[0][0]).toBe('gAjR4_CbPpQ');
    });

    it('reports 30 s and preview: true when only the preview will play', async () => {
        fetchMock.mockResolvedValueOnce(json(200, dzTrack()));
        resolveSpy.mockResolvedValueOnce({ status: 'not_found', videoId: null });
        const res = await request(app).get(withMedia('/duration?source=deezer&videoId=3135556'));
        expect(res.body).toEqual({ duration: 30, preview: true });
    });

    it('one play (stream + duration) is one Deezer request', async () => {
        fetchMock.mockResolvedValue(json(200, dzTrack()));
        resolveSpy.mockResolvedValue({ status: 'not_found', videoId: null });
        await Promise.all([
            request(app).get(withMedia('/stream?source=deezer&videoId=3135556')),
            request(app).get(withMedia('/duration?source=deezer&videoId=3135556'))
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
