// Stage 2: the match engine's HTTP routes, the match-mode /stream and /duration
// path, and the filterPlayable hook on the library lists. The engine itself
// (services/matcher) is mocked here; its own tests cover resolution. This file
// covers the wiring around it: auth, validation, status codes and that the
// YouTube side is called with the matched id and never with the Spotify one.
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../controllers/youtubeClient', () => ({ getYouTubeClient: jest.fn() }));

// The engine is faked with jest.fn so each route's wiring can be asserted on
// its own; the real engine is exercised in tests/matcher.engine.test.js and
// tests/matcher.e2e.test.js.
jest.mock('../services/matcher', () => ({
    getMatch: jest.fn(),
    resolve: jest.fn(),
    resolveMany: jest.fn(),
    filterPlayable: jest.fn(),
    setOverride: jest.fn(),
    markUnavailable: jest.fn(),
    report: jest.fn(),
    forget: jest.fn(),
    isMatchSource: jest.fn(),
    matchSources: jest.fn(),
    keyOf: (t) => `${t.source}:${t.id}`,
    _internals: { queue: null, inFlight: new Map(), resetForTests: jest.fn() }
}));

const { getYouTubeClient } = require('../controllers/youtubeClient');
const matcher = require('../services/matcher');
const YouTubeController = require('../controllers/YouTubeController');
const app = require('../app');

const validToken = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${validToken}` };

const SPOTIFY_ID = '3n3Ppam7vgaVa1iaRUc9Lp'; // 22 base62 chars, like a real Spotify track id
const YT_ID = 'dQw4w9WgXcQ';
const FRESH = { access_token: 'yt-token', expires_at: Date.now() + 60 * 60 * 1000 };

const matchedRow = (over = {}) => ({
    source: 'spotify', externalId: SPOTIFY_ID, status: 'matched', videoId: YT_ID, score: 95, method: 'ytmusic',
    candidates: [{ videoId: YT_ID, title: 'Song', ok: true, score: 95 }], checkedAt: 1760000000000, manual: false, isrc: null,
    ...over
});

// A googleapis client whose every call is a jest.fn returning { data }.
function fakeYouTube() {
    const yt = {
        playlists: { list: jest.fn() },
        playlistItems: { list: jest.fn() },
        videos: { list: jest.fn(), rate: jest.fn().mockResolvedValue({}) },
        search: { list: jest.fn() }
    };
    getYouTubeClient.mockReturnValue(yt);
    return yt;
}

let streamVideo;
let durationOf;

beforeEach(() => {
    // Reset, not clear: clearAllMocks keeps queued mockResolvedValueOnce
    // values, so a request that outlives its test (a timeout under load)
    // would hand its value to the next test and shift every later queue.
    jest.resetAllMocks();
    app.locals.db = { get: jest.fn(), all: jest.fn(), run: jest.fn().mockResolvedValue({}) };
    // Default: spotify is the only match-mode source, as in the engine's constant list.
    matcher.isMatchSource.mockImplementation(name => name === 'spotify');
    matcher.matchSources.mockReturnValue(['spotify']);
    // The YouTube side is stubbed so no test spawns yt-dlp.
    streamVideo = jest.spyOn(YouTubeController, 'streamVideo').mockImplementation((req, res, videoId) => res.status(200).json({ streamed: videoId }));
    durationOf = jest.spyOn(YouTubeController, 'durationOf').mockResolvedValue(248);
});

afterEach(() => {
    streamVideo.mockRestore();
    durationOf.mockRestore();
});

// --- Auth -----------------------------------------------------------------------

describe('Auth is enforced on every /api/match route', () => {
    it.each([
        ['get', `/api/match/spotify/${SPOTIFY_ID}`],
        ['post', '/api/match/resolve'],
        ['post', '/api/match/override'],
        ['post', '/api/match/report'],
        ['delete', `/api/match/spotify/${SPOTIFY_ID}`]
    ])('%s %s returns 401 without our login and never reaches the engine', async (method, path) => {
        const res = await request(app)[method](path).send({ tracks: [], source: 'spotify', id: SPOTIFY_ID, videoId: YT_ID, reason: 'other' });
        expect(res.statusCode).toBe(401);
        expect(matcher.getMatch).not.toHaveBeenCalled();
        expect(matcher.resolveMany).not.toHaveBeenCalled();
        expect(matcher.setOverride).not.toHaveBeenCalled();
        expect(matcher.report).not.toHaveBeenCalled();
        expect(matcher.forget).not.toHaveBeenCalled();
        expect(app.locals.db.run).not.toHaveBeenCalled();
    });
});

// --- GET /api/match/:source/:id -------------------------------------------------------

describe('GET /api/match/:source/:id', () => {
    it('refuses an unknown source with MATCH_BAD_SOURCE and does not echo the name', async () => {
        const res = await request(app).get('/api/match/napster/abc').set(auth);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MATCH_BAD_SOURCE');
        expect(JSON.stringify(res.body)).not.toContain('napster');
        expect(matcher.getMatch).not.toHaveBeenCalled();
    });

    it('refuses a source that is not in match mode (youtube plays directly)', async () => {
        const res = await request(app).get(`/api/match/youtube/${YT_ID}`).set(auth);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MATCH_BAD_SOURCE');
    });

    it('refuses a malformed or over-long id with MATCH_BAD_REQUEST', async () => {
        const long = await request(app).get(`/api/match/spotify/${'a'.repeat(129)}`).set(auth);
        expect(long.statusCode).toBe(400);
        expect(long.body.code).toBe('MATCH_BAD_REQUEST');

        const odd = await request(app).get('/api/match/spotify/bad%20id').set(auth);
        expect(odd.statusCode).toBe(400);
        expect(odd.body.code).toBe('MATCH_BAD_REQUEST');
        expect(matcher.getMatch).not.toHaveBeenCalled();
    });

    it('returns 404 MATCH_NOT_FOUND when no row exists', async () => {
        matcher.getMatch.mockResolvedValueOnce(null);
        const res = await request(app).get(`/api/match/spotify/${SPOTIFY_ID}`).set(auth);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('MATCH_NOT_FOUND');
        expect(matcher.getMatch).toHaveBeenCalledWith(app.locals.db, 'spotify', SPOTIFY_ID);
    });

    it('returns the stored match with its candidates', async () => {
        matcher.getMatch.mockResolvedValueOnce(matchedRow({ manual: true, method: 'manual', score: null }));
        const res = await request(app).get(`/api/match/spotify/${SPOTIFY_ID}`).set(auth);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            source: 'spotify',
            id: SPOTIFY_ID,
            status: 'matched',
            videoId: YT_ID,
            score: null,
            method: 'manual',
            candidates: [{ videoId: YT_ID, title: 'Song', ok: true, score: 95 }],
            checkedAt: 1760000000000,
            manual: true
        });
    });
});

// --- POST /api/match/resolve ----------------------------------------------------------

describe('POST /api/match/resolve', () => {
    const track = (over = {}) => ({ source: 'spotify', id: SPOTIFY_ID, title: 'Get Lucky', artist: 'Daft Punk', durationSec: 369, ...over });

    it.each([
        ['no body', {}],
        ['an empty list', { tracks: [] }],
        ['more than 100 tracks', { tracks: Array.from({ length: 101 }, (_, i) => track({ id: `id${i}` })) }],
        ['a track without a title', { tracks: [{ source: 'spotify', id: SPOTIFY_ID }] }],
        ['a title over 300 characters', { tracks: [track({ title: 'x'.repeat(301) })] }],
        ['an id over 128 characters', { tracks: [track({ id: 'a'.repeat(129) })] }],
        ['a non-array artists field', { tracks: [track({ artists: 'Daft Punk' })] }],
        ['a negative duration', { tracks: [track({ durationSec: -1 })] }],
        ['a track that is not an object', { tracks: ['Get Lucky'] }]
    ])('rejects %s with 400 MATCH_BAD_REQUEST before calling the engine', async (_label, body) => {
        const res = await request(app).post('/api/match/resolve').set(auth).send(body);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MATCH_BAD_REQUEST');
        expect(matcher.resolveMany).not.toHaveBeenCalled();
    });

    it('rejects a track of a non-match source with MATCH_BAD_SOURCE, without echoing it', async () => {
        const res = await request(app).post('/api/match/resolve').set(auth).send({ tracks: [track({ source: 'napster' })] });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MATCH_BAD_SOURCE');
        expect(JSON.stringify(res.body)).not.toContain('napster');
        expect(matcher.resolveMany).not.toHaveBeenCalled();
    });

    it('resolves every track through the engine and reports results by key plus a summary', async () => {
        const second = track({ id: '0DiWol3AO6WpXZgp0goxAV', title: 'One More Time', durationSec: 320 });
        const third = track({ id: '2cGxRwrMyEAp8dEbuZaVv6', title: 'Something About Us' });
        matcher.resolveMany.mockResolvedValueOnce(new Map([
            [`spotify:${SPOTIFY_ID}`, { status: 'matched', videoId: YT_ID, score: 95, method: 'ytmusic', candidates: [], fromCache: true }],
            [`spotify:${second.id}`, { status: 'not_found', videoId: null, score: null, method: 'ytmusic', candidates: [] }]
            // the third is missing from the map: it must read as pending, not crash
        ]));

        const res = await request(app).post('/api/match/resolve').set(auth)
            .send({ tracks: [track({ evil: 'ignored', artists: ['Daft Punk', 'Pharrell Williams'], album: 'RAM', isrc: 'USQX91300108' }), second, third] });

        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual({
            [`spotify:${SPOTIFY_ID}`]: { status: 'matched', videoId: YT_ID, score: 95, method: 'ytmusic' },
            [`spotify:${second.id}`]: { status: 'not_found', videoId: null, score: null, method: 'ytmusic' },
            [`spotify:${third.id}`]: { status: 'pending', videoId: null, score: null, method: null }
        });
        expect(res.body.summary).toEqual({ total: 3, matched: 1, hidden: 2, pending: 1, errors: 0 });

        // The engine receives only the whitelisted fields, never client extras.
        const [db, tracks] = matcher.resolveMany.mock.calls[0];
        expect(db).toBe(app.locals.db);
        expect(tracks).toHaveLength(3);
        expect(tracks[0]).toEqual({
            source: 'spotify', id: SPOTIFY_ID, title: 'Get Lucky', artist: 'Daft Punk', album: 'RAM', durationSec: 369,
            artists: ['Daft Punk', 'Pharrell Williams']
        });
        expect(tracks[0]).not.toHaveProperty('evil');
        // A client-supplied ISRC is a cross-track identity key: it is never
        // forwarded, however it is spelled, so one caller cannot poison another track's match.
        expect(tracks[0]).not.toHaveProperty('isrc');
        expect(tracks[2]).toMatchObject({ album: null });
        expect(tracks[2]).not.toHaveProperty('isrc');
    });

    it('ignores a malformed isrc rather than validating it', async () => {
        matcher.resolveMany.mockResolvedValueOnce(new Map());
        const res = await request(app).post('/api/match/resolve').set(auth).send({ tracks: [track({ isrc: 'x'.repeat(5000) })] });
        expect(res.statusCode).toBe(200);
        expect(matcher.resolveMany.mock.calls[0][1][0]).not.toHaveProperty('isrc');
    });
});

// --- POST /api/match/override ----------------------------------------------------------

describe('POST /api/match/override', () => {
    beforeEach(() => {
        // requireExistingUser: the token's user still exists.
        app.locals.db.get.mockResolvedValue({ id: 1 });
    });

    it('answers 401 USER_NOT_FOUND for a valid token of a deleted user, before the engine', async () => {
        app.locals.db.get.mockResolvedValue(undefined);
        const res = await request(app).post('/api/match/override').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, videoId: YT_ID });
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('USER_NOT_FOUND');
        expect(matcher.setOverride).not.toHaveBeenCalled();
    });

    it('rejects a non-YouTube videoId and a non-match source', async () => {
        const bad = await request(app).post('/api/match/override').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, videoId: 'short' });
        expect(bad.statusCode).toBe(400);
        expect(bad.body.code).toBe('MATCH_BAD_REQUEST');

        const src = await request(app).post('/api/match/override').set(auth).send({ source: 'youtube', id: YT_ID, videoId: YT_ID });
        expect(src.statusCode).toBe(400);
        expect(src.body.code).toBe('MATCH_BAD_SOURCE');
        expect(matcher.setOverride).not.toHaveBeenCalled();
    });

    it('stores the override for the logged-in user and answers 204, never forwarding a client isrc', async () => {
        matcher.setOverride.mockResolvedValueOnce(undefined);
        const res = await request(app).post('/api/match/override').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, videoId: YT_ID, isrc: 'USQX91300108' });
        expect(res.statusCode).toBe(204);
        expect(matcher.setOverride).toHaveBeenCalledWith(app.locals.db, { source: 'spotify', externalId: SPOTIFY_ID, videoId: YT_ID, userId: 1 });
        expect(matcher.setOverride.mock.calls[0][1]).not.toHaveProperty('isrc');
    });
});

// --- POST /api/match/report ------------------------------------------------------------

describe('POST /api/match/report', () => {
    beforeEach(() => {
        app.locals.db.get.mockResolvedValue({ id: 1 });
    });

    it('answers 401 USER_NOT_FOUND for a deleted user instead of a foreign-key 500', async () => {
        app.locals.db.get.mockResolvedValue(undefined);
        const res = await request(app).post('/api/match/report').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, reason: 'other' });
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('USER_NOT_FOUND');
        expect(matcher.report).not.toHaveBeenCalled();
    });

    it('rejects an unknown reason, a bad videoId and an over-long note', async () => {
        const reason = await request(app).post('/api/match/report').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, reason: 'meh' });
        expect(reason.statusCode).toBe(400);
        expect(reason.body.code).toBe('MATCH_BAD_REQUEST');

        const video = await request(app).post('/api/match/report').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, reason: 'wrong_match', videoId: 'nope' });
        expect(video.statusCode).toBe(400);

        const note = await request(app).post('/api/match/report').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, reason: 'other', note: 'x'.repeat(501) });
        expect(note.statusCode).toBe(400);
        expect(matcher.report).not.toHaveBeenCalled();
    });

    it('records the report with the user, the suggested video and the note', async () => {
        matcher.report.mockResolvedValueOnce(undefined);
        const res = await request(app).post('/api/match/report').set(auth)
            .send({ source: 'spotify', id: SPOTIFY_ID, reason: 'wrong_match', videoId: YT_ID, note: 'Live version' });
        expect(res.statusCode).toBe(204);
        expect(matcher.report).toHaveBeenCalledWith(app.locals.db, {
            source: 'spotify', externalId: SPOTIFY_ID, userId: 1, reason: 'wrong_match', videoId: YT_ID, note: 'Live version'
        });
    });

    it('records an unavailable report with no video and no note', async () => {
        matcher.report.mockResolvedValueOnce(undefined);
        const res = await request(app).post('/api/match/report').set(auth).send({ source: 'spotify', id: SPOTIFY_ID, reason: 'unavailable' });
        expect(res.statusCode).toBe(204);
        expect(matcher.report.mock.calls[0][1]).toMatchObject({ reason: 'unavailable', videoId: null, note: null });
    });
});

// --- DELETE /api/match/:source/:id -----------------------------------------------------

describe('DELETE /api/match/:source/:id', () => {
    it('forgets the row through the engine so the next read re-resolves, and answers 204', async () => {
        matcher.forget.mockResolvedValueOnce(undefined);
        const res = await request(app).delete(`/api/match/spotify/${SPOTIFY_ID}`).set(auth);
        expect(res.statusCode).toBe(204);
        expect(matcher.forget).toHaveBeenCalledWith(app.locals.db, 'spotify', SPOTIFY_ID);
        // No SQL from the controller: the engine owns the row and its in-flight state.
        expect(app.locals.db.run).not.toHaveBeenCalled();
    });

    it('refuses an unknown source without touching the engine', async () => {
        const res = await request(app).delete('/api/match/napster/abc').set(auth);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MATCH_BAD_SOURCE');
        expect(matcher.forget).not.toHaveBeenCalled();
    });

    it('reports an engine failure as 500', async () => {
        matcher.forget.mockRejectedValueOnce(new Error('db down'));
        const res = await request(app).delete(`/api/match/spotify/${SPOTIFY_ID}`).set(auth);
        expect(res.statusCode).toBe(500);
    });
});

// --- /stream and /duration for a match-mode source -------------------------------------

describe('GET /stream?source=spotify', () => {
    it('streams the matched YouTube video, passing the YouTube id without mutating the request', async () => {
        matcher.getMatch.mockResolvedValueOnce(matchedRow());

        const res = await request(app).get(`/stream?source=spotify&videoId=${SPOTIFY_ID}`);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ streamed: YT_ID });
        expect(matcher.getMatch).toHaveBeenCalledWith(app.locals.db, 'spotify', SPOTIFY_ID);
        const [req, , videoId] = streamVideo.mock.calls[0];
        expect(videoId).toBe(YT_ID);                 // the cache key stays the YouTube id
        expect(req.query.videoId).toBe(SPOTIFY_ID);  // the request still carries the Spotify id
    });

    it('returns 404 MATCH_REQUIRED when the track has no row yet', async () => {
        matcher.getMatch.mockResolvedValueOnce(null);
        const res = await request(app).get(`/stream?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: 'Track has not been matched yet', code: 'MATCH_REQUIRED' });
        expect(streamVideo).not.toHaveBeenCalled();
    });

    it('returns 404 TRACK_UNAVAILABLE for a not_found row', async () => {
        matcher.getMatch.mockResolvedValueOnce(matchedRow({ status: 'not_found', videoId: null }));
        const res = await request(app).get(`/stream?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('TRACK_UNAVAILABLE');
        expect(streamVideo).not.toHaveBeenCalled();
    });

    it.each(['error', 'pending'])('returns 503 MATCH_PENDING for a %s row', async (status) => {
        matcher.getMatch.mockResolvedValueOnce(matchedRow({ status, videoId: null }));
        const res = await request(app).get(`/stream?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('MATCH_PENDING');
        expect(streamVideo).not.toHaveBeenCalled();
    });

    it('validates the external id before looking anything up', async () => {
        const bad = await request(app).get('/stream?source=spotify&videoId=../x');
        expect(bad.statusCode).toBe(400);
        const missing = await request(app).get('/stream?source=spotify');
        expect(missing.statusCode).toBe(400);
        const long = await request(app).get(`/stream?source=spotify&videoId=${'a'.repeat(129)}`);
        expect(long.statusCode).toBe(400);
        expect(matcher.getMatch).not.toHaveBeenCalled();
        expect(streamVideo).not.toHaveBeenCalled();
    });

    it('reports a failed match lookup as 500 instead of hanging the <audio> element', async () => {
        matcher.getMatch.mockRejectedValueOnce(new Error('db down'));
        const res = await request(app).get(`/stream?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(res.statusCode).toBe(500);
        expect(streamVideo).not.toHaveBeenCalled();
    });

    it('the YouTube source keeps validating its own id and seek before yt-dlp', async () => {
        expect((await request(app).get('/stream?videoId=short')).statusCode).toBe(400);
        expect((await request(app).get('/stream')).body).toEqual({ error: 'Missing videoId' });
        const seek = await request(app).get(`/stream?videoId=${YT_ID}&seek=abc`);
        expect(seek.statusCode).toBe(400);
        expect(seek.body.error).toMatch(/seek/i);
        expect(matcher.getMatch).not.toHaveBeenCalled();
    });
});

describe('GET /duration?source=spotify', () => {
    it('answers with the matched video\'s duration', async () => {
        matcher.getMatch.mockResolvedValueOnce(matchedRow());
        const res = await request(app).get(`/duration?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ duration: 248 });
        expect(durationOf).toHaveBeenCalledWith(YT_ID);
    });

    it('mirrors the stream status codes when there is nothing to play', async () => {
        matcher.getMatch.mockResolvedValueOnce(null);
        const none = await request(app).get(`/duration?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(none.statusCode).toBe(404);
        expect(none.body.code).toBe('MATCH_REQUIRED');

        matcher.getMatch.mockResolvedValueOnce(matchedRow({ status: 'not_found', videoId: null }));
        const gone = await request(app).get(`/duration?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(gone.statusCode).toBe(404);
        expect(gone.body.code).toBe('TRACK_UNAVAILABLE');

        matcher.getMatch.mockResolvedValueOnce(matchedRow({ status: 'error', videoId: null }));
        const pending = await request(app).get(`/duration?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(pending.statusCode).toBe(503);
        expect(pending.body.code).toBe('MATCH_PENDING');
        expect(durationOf).not.toHaveBeenCalled();
    });

    it('answers 502 { duration: 0 } when yt-dlp fails, like the YouTube route does', async () => {
        matcher.getMatch.mockResolvedValueOnce(matchedRow());
        durationOf.mockRejectedValueOnce(new Error('yt-dlp failed'));
        const res = await request(app).get(`/duration?source=spotify&videoId=${SPOTIFY_ID}`);
        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({ duration: 0 });
    });

    it('the YouTube source still validates its own id', async () => {
        expect((await request(app).get('/duration?videoId=short')).statusCode).toBe(400);
        expect(matcher.getMatch).not.toHaveBeenCalled();
    });
});

// --- Library lists hide unmatched match-mode tracks ------------------------------------

describe('Library lists and the match engine', () => {
    // Pretend the engine matched exactly one track and hid the rest, so the
    // response shape (filtered items + `matching`) can be asserted without a
    // real engine. Only the ids in `keep` survive.
    function engineKeeps(keep, summary) {
        matcher.filterPlayable.mockImplementation(async (db, items) => ({
            items: items.filter(t => keep.includes(t.id)).map(t => ({ ...t, youtubeId: YT_ID, match: { status: 'matched', score: 90, method: 'ytmusic' } })),
            summary
        }));
    }

    it('custom playlist tracks of a match-mode source are filtered; other sources pass through', async () => {
        app.locals.db.get.mockResolvedValueOnce({ id: 5 }); // ownership
        app.locals.db.all.mockResolvedValueOnce([
            { rowId: 1, id: YT_ID, title: 'A', artist: 'X', thumbnail: null, source: 'youtube' },
            { rowId: 2, id: SPOTIFY_ID, title: 'B', artist: 'Y', thumbnail: null, source: 'spotify' },
            { rowId: 3, id: '0DiWol3AO6WpXZgp0goxAV', title: 'C', artist: 'Z', thumbnail: null, source: 'spotify' }
        ]);
        const summary = { total: 3, matched: 2, hidden: 1, pending: 0, errors: 0 };
        engineKeeps([YT_ID, SPOTIFY_ID], summary);

        const res = await request(app).get('/api/library/custom/playlists/5/tracks').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items.map(t => t.id)).toEqual([YT_ID, SPOTIFY_ID]);
        expect(res.body.items[1]).toMatchObject({ source: 'spotify', youtubeId: YT_ID, match: { status: 'matched' } });
        expect(res.body.matching).toEqual(summary);
        expect(res.body.nextCursor).toBeNull();

        // The whole normalised page went to the engine, in order, with the app db.
        const [db, items] = matcher.filterPlayable.mock.calls[0];
        expect(db).toBe(app.locals.db);
        expect(items.map(t => `${t.source}:${t.id}`)).toEqual([`youtube:${YT_ID}`, `spotify:${SPOTIFY_ID}`, 'spotify:0DiWol3AO6WpXZgp0goxAV']);
    });

    it('a page with no match-mode tracks never calls the engine and carries no matching key', async () => {
        app.locals.db.get.mockResolvedValueOnce({ id: 5 });
        app.locals.db.all.mockResolvedValueOnce([
            { rowId: 1, id: YT_ID, title: 'A', artist: 'X', thumbnail: null, source: 'youtube' },
            { rowId: 2, id: '123', title: 'B', artist: 'Y', thumbnail: null, source: 'soundcloud' }
        ]);

        const res = await request(app).get('/api/library/custom/playlists/5/tracks').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(2);
        expect(res.body).not.toHaveProperty('matching');
        expect(matcher.filterPlayable).not.toHaveBeenCalled();
    });

    it('provider playlist tracks are filtered and keep their cursor when the source is in match mode', async () => {
        // Simulate a match-mode provider by telling the engine youtube is one;
        // the real Spotify provider arrives in the next task.
        matcher.isMatchSource.mockImplementation(name => name === 'youtube');
        app.locals.db.get.mockResolvedValue(FRESH);
        const yt = fakeYouTube();
        yt.playlistItems.list.mockResolvedValueOnce({ data: {
            items: [
                { snippet: { title: 'A', videoOwnerChannelTitle: 'Owner', resourceId: { videoId: 'aaaaaaaaaaa' }, thumbnails: {} } },
                { snippet: { title: 'B', videoOwnerChannelTitle: 'Owner', resourceId: { videoId: 'bbbbbbbbbbb' }, thumbnails: {} } }
            ],
            nextPageToken: 'P2'
        } });
        const summary = { total: 2, matched: 1, hidden: 1, pending: 0, errors: 0 };
        engineKeeps(['bbbbbbbbbbb'], summary);

        const res = await request(app).get('/api/library/youtube/playlists/PL1/tracks').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items.map(t => t.id)).toEqual(['bbbbbbbbbbb']);
        expect(res.body.matching).toEqual(summary);
        expect(res.body.nextCursor).toBe('P2'); // a shorter page must not end paging
    });

    it('search results are filtered the same way and keep the provider\'s extra fields', async () => {
        matcher.isMatchSource.mockImplementation(name => name === 'youtube');
        app.locals.db.get.mockResolvedValue(FRESH);
        const yt = fakeYouTube();
        yt.search.list.mockResolvedValueOnce({ data: { items: [{ id: { videoId: 'aaaaaaaaaaa' } }, { id: { videoId: 'bbbbbbbbbbb' } }], nextPageToken: 'S2' } });
        yt.videos.list.mockResolvedValueOnce({ data: { items: [
            { id: 'aaaaaaaaaaa', snippet: { title: 'A', channelTitle: 'Artist', thumbnails: {} }, contentDetails: { duration: 'PT2M' } },
            { id: 'bbbbbbbbbbb', snippet: { title: 'B', channelTitle: 'Artist', thumbnails: {} }, contentDetails: { duration: 'PT3M' } }
        ] } });
        const summary = { total: 2, matched: 1, hidden: 1, pending: 0, errors: 0 };
        engineKeeps(['aaaaaaaaaaa'], summary);

        const res = await request(app).get('/api/search/youtube?q=hello').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items.map(t => t.id)).toEqual(['aaaaaaaaaaa']);
        expect(res.body.items[0]).toMatchObject({ youtubeId: YT_ID, match: { status: 'matched', score: 90, method: 'ytmusic' } });
        expect(res.body.matching).toEqual(summary);
        expect(res.body.nextCursor).toBe('S2');
        expect(matcher.filterPlayable).toHaveBeenCalledTimes(1);
    });

    it('search with no match-mode results never calls the engine', async () => {
        app.locals.db.get.mockResolvedValue(FRESH);
        const yt = fakeYouTube();
        yt.search.list.mockResolvedValueOnce({ data: { items: [{ id: { videoId: 'aaaaaaaaaaa' } }], nextPageToken: undefined } });
        yt.videos.list.mockResolvedValueOnce({ data: { items: [{ id: 'aaaaaaaaaaa', snippet: { title: 'A', channelTitle: 'Artist', thumbnails: {} }, contentDetails: { duration: 'PT2M' } }] } });

        const res = await request(app).get('/api/search/youtube?q=hello').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items).toHaveLength(1);
        expect(res.body).not.toHaveProperty('matching');
        expect(matcher.filterPlayable).not.toHaveBeenCalled();
    });

    it('a match-table failure is reported as a server error, not as a provider error', async () => {
        app.locals.db.get.mockResolvedValueOnce({ id: 5 });
        app.locals.db.all.mockResolvedValueOnce([{ rowId: 2, id: SPOTIFY_ID, title: 'B', artist: 'Y', thumbnail: null, source: 'spotify' }]);
        matcher.filterPlayable.mockRejectedValueOnce(new Error('table missing'));

        const res = await request(app).get('/api/library/custom/playlists/5/tracks').set(auth);

        expect(res.statusCode).toBe(500);
        expect(res.body.code).toBeUndefined();
    });
});

// --- Resolve rate limit ----------------------------------------------------------------
// Last on purpose: the limiter's per-IP counter is shared by every test in this
// file (one app instance), so the test that exhausts it must run after the
// others that call /api/match/resolve.

describe('POST /api/match/resolve rate limit', () => {
    it('answers 429 after 120 requests from one address within the window', async () => {
        let limitedAt = null;
        for (let i = 1; i <= 125 && limitedAt === null; i++) {
            const res = await request(app).post('/api/match/resolve').set(auth).send({});
            if (res.statusCode === 429) limitedAt = i;
            else expect(res.statusCode).toBe(400); // the invalid body, counted all the same
        }
        // The earlier tests in this file already spent some of the 120.
        expect(limitedAt).not.toBeNull();
        expect(limitedAt).toBeLessThanOrEqual(121);
        expect(matcher.resolveMany).not.toHaveBeenCalled();
        // Other match routes are not throttled by the resolve limiter.
        matcher.getMatch.mockResolvedValueOnce(null);
        expect((await request(app).get(`/api/match/spotify/${SPOTIFY_ID}`).set(auth)).statusCode).toBe(404);
    });
});
