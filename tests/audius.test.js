// Audius (ROADMAP Stage 6): search and playback, no account. Responses are
// shaped after Audius's OpenAPI spec (AudiusProject/audius-protocol,
// packages/docs/docs/public/openapi.yaml): { data: Track[] } for search,
// { data: Track } for a track, { data: "<url>" } for stream?no_redirect=true.
const mockStreamTranscoded = jest.fn();
jest.mock('../controllers/transcode', () => ({
    ...jest.requireActual('../controllers/transcode'),
    serveFromCache: () => false,
    streamTranscoded: (...args) => mockStreamTranscoded(...args)
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../app');
const audius = require('../providers/audius');
const { withMedia } = require('./helpers/media');

const auth = { Authorization: `Bearer ${jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' })}` };

const track = (over = {}) => ({
    id: 'D7KyD',
    title: 'Night Drive',
    duration: 214,
    user: { id: 'nlGNe', name: 'Synth Person', handle: 'synthperson' },
    artwork: {
        '150x150': 'https://creatornode.example/content/Qm1/150x150.jpg',
        '480x480': 'https://creatornode.example/content/Qm1/480x480.jpg',
        '1000x1000': 'https://creatornode.example/content/Qm1/1000x1000.jpg',
        mirrors: ['https://mirror.example']
    },
    permalink: '/synthperson/night-drive',
    isrc: 'USABC2400001',
    is_streamable: true,
    is_stream_gated: false,
    preview_cid: null,
    is_delete: false,
    is_available: true,
    ...over
});

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock;
beforeEach(() => {
    fetchMock = jest.fn();
    audius.http.fetch = fetchMock;
    mockStreamTranscoded.mockReset();
    app.locals.db = { get: jest.fn(), all: jest.fn().mockResolvedValue([]), run: jest.fn() };
    delete process.env.AUDIUS_API_KEY;
});

describe('normalisation', () => {
    it('maps an Audius track to the shared Track shape', () => {
        expect(audius.toTrack(track())).toMatchObject({
            source: 'audius', id: 'D7KyD', title: 'Night Drive', artist: 'Synth Person',
            durationSec: 214, thumbnail: 'https://creatornode.example/content/Qm1/480x480.jpg',
            isrc: 'USABC2400001', preview: false, playable: true,
            permalinkUrl: 'https://audius.co/synthperson/night-drive'
        });
    });

    it('marks gated tracks with a preview as preview, and others as not playable', () => {
        expect(audius.toTrack(track({ is_stream_gated: true, preview_cid: 'QmPrev' }))).toMatchObject({ preview: true, playable: true });
        expect(audius.toTrack(track({ is_stream_gated: true, preview_cid: null })).playable).toBe(false);
        expect(audius.toTrack(track({ is_streamable: false })).playable).toBe(false);
        expect(audius.toTrack(track({ is_delete: true })).playable).toBe(false);
    });

    it('never passes on a non-https artwork or a malformed permalink', () => {
        const t = audius.toTrack(track({ artwork: { '480x480': 'http://insecure.example/a.jpg' }, permalink: 'https://evil.example/x' }));
        expect(t.thumbnail).toBeNull();
        expect(t.permalinkUrl).toBeNull();
    });
});

describe('GET /api/search/audius', () => {
    it('searches without any connection and pages by offset', async () => {
        const page1 = Array.from({ length: 30 }, (_, i) => track({ id: `id${i}`, title: `T${i}` }));
        fetchMock.mockResolvedValueOnce(json(200, { data: page1 }));
        const res = await request(app).get('/api/search/audius?q=night drive').set(auth);
        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(30);
        expect(res.body.items[0]).toMatchObject({ source: 'audius', id: 'id0' });
        expect(res.body.nextCursor).toBe('30');
        const url = new URL(fetchMock.mock.calls[0][0]);
        expect(url.origin + url.pathname).toBe('https://api.audius.co/v1/tracks/search');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ query: 'night drive', offset: '0', limit: '30' });

        fetchMock.mockResolvedValueOnce(json(200, { data: [track()] }));
        const res2 = await request(app).get('/api/search/audius?q=night drive&cursor=30').set(auth);
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('offset')).toBe('30');
        expect(res2.body.nextCursor).toBeNull(); // short page: no more
    });

    it('drops results with an unusable id and rejects a bad cursor', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { data: [track(), track({ id: '../x' })] }));
        const res = await request(app).get('/api/search/audius?q=x').set(auth);
        expect(res.body.items.map((t) => t.id)).toEqual(['D7KyD']);
        const bad = await request(app).get('/api/search/audius?q=x&cursor=-5').set(auth);
        expect(bad.statusCode).toBe(400);
    });

    it('maps rate limits and outages', async () => {
        fetchMock.mockResolvedValueOnce(json(429, {}));
        const limited = await request(app).get('/api/search/audius?q=x').set(auth);
        expect(limited.statusCode).toBe(429);
        jest.spyOn(console, 'error').mockImplementation(() => {});
        fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
        const down = await request(app).get('/api/search/audius?q=x').set(auth);
        console.error.mockRestore();
        expect(down.statusCode).toBe(502);
        expect(down.body.source).toBe('audius');
    });
});

describe('GET /api/sources', () => {
    it('lists Audius as searchable without a connection and with no library', async () => {
        const res = await request(app).get('/api/sources').set(auth);
        const a = res.body.sources.find((s) => s.name === 'audius');
        expect(a).toMatchObject({
            label: 'Audius', connected: true, searchRequiresConnection: false,
            connect: { required: false, kind: 'none' },
            capabilities: { search: true, playlists: false, stream: true }
        });
    });
});

describe('/stream?source=audius', () => {
    it('resolves the MP3 URL and streams it through the shared pipeline', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { data: track() }))
            .mockResolvedValueOnce(json(200, { data: 'https://creatornode.example/tracks/cidstream/D7KyD.mp3' }));
        mockStreamTranscoded.mockImplementation((req, res) => res.status(200).end());

        const res = await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD'));
        expect(res.statusCode).toBe(200);
        const streamUrl = new URL(fetchMock.mock.calls[1][0]);
        expect(streamUrl.pathname).toBe('/v1/tracks/D7KyD/stream');
        expect(streamUrl.searchParams.get('no_redirect')).toBe('true');
        expect(streamUrl.searchParams.has('preview')).toBe(false);
        expect(mockStreamTranscoded.mock.calls[0][2]).toMatchObject({
            sourceUrl: 'https://creatornode.example/tracks/cidstream/D7KyD.mp3',
            cacheKey: 'audius_D7KyD', seekTime: 0, allowCache: true
        });
    });

    it('plays the preview of a gated track, and does not cache it', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { data: track({ is_stream_gated: true, preview_cid: 'QmPrev' }) }))
            .mockResolvedValueOnce(json(200, { data: 'https://creatornode.example/preview.mp3' }));
        mockStreamTranscoded.mockImplementation((req, res) => res.status(200).end());
        await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD'));
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('preview')).toBe('true');
        expect(mockStreamTranscoded.mock.calls[0][2].allowCache).toBe(false);
    });

    it('sends AUDIUS_API_KEY on the stream request when set', async () => {
        process.env.AUDIUS_API_KEY = 'my-free-key';
        fetchMock
            .mockResolvedValueOnce(json(200, { data: track() }))
            .mockResolvedValueOnce(json(200, { data: 'https://creatornode.example/s.mp3' }));
        mockStreamTranscoded.mockImplementation((req, res) => res.status(200).end());
        await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD'));
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('api_key')).toBe('my-free-key');
    });

    it('answers TRACK_UNAVAILABLE for a gated track without a preview, without streaming', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { data: track({ is_stream_gated: true, preview_cid: null }) }));
        const res = await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD'));
        expect(res.statusCode).toBe(404);
        expect(res.body).toMatchObject({ code: 'TRACK_UNAVAILABLE', source: 'audius' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mockStreamTranscoded).not.toHaveBeenCalled();
    });

    it('refuses a non-https stream URL from the API', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        fetchMock
            .mockResolvedValueOnce(json(200, { data: track() }))
            .mockResolvedValueOnce(json(200, { data: 'file:///etc/passwd' }));
        const res = await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD'));
        console.error.mockRestore();
        expect(res.statusCode).toBe(502);
        expect(mockStreamTranscoded).not.toHaveBeenCalled();
    });

    it('uses a separate cache entry for another quality, and rejects an unknown one', async () => {
        fetchMock
            .mockResolvedValueOnce(json(200, { data: track() }))
            .mockResolvedValueOnce(json(200, { data: 'https://creatornode.example/s.mp3' }));
        mockStreamTranscoded.mockImplementation((req, res) => res.status(200).end());
        await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD&quality=high'));
        expect(mockStreamTranscoded.mock.calls[0][2].cacheKey).toBe('audius_D7KyD_q256');
        expect(mockStreamTranscoded.mock.calls[0][0].query.quality).toBe('high');

        const bad = await request(app).get(withMedia('/stream?source=audius&videoId=D7KyD&quality=ultra'));
        expect(bad.statusCode).toBe(400);
        expect(fetchMock).toHaveBeenCalledTimes(2); // nothing fetched for the rejected request
    });

    it('validates the id and requires a media token', async () => {
        expect((await request(app).get(withMedia('/stream?source=audius&videoId=../etc'))).statusCode).toBe(400);
        expect((await request(app).get('/stream?source=audius&videoId=D7KyD')).statusCode).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('/duration?source=audius', () => {
    it('reads the duration from the track', async () => {
        fetchMock.mockResolvedValueOnce(json(200, { data: track({ duration: 187 }) }));
        const res = await request(app).get(withMedia('/duration?source=audius&videoId=D7KyD'));
        expect(res.body).toEqual({ duration: 187 });
    });
});
