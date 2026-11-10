// Stage 0: the generic library API, provider registry and normalised shapes.
// googleapis is stubbed through controllers/youtubeClient so no test touches
// YouTube; SoundCloud's network is stubbed through its client.http.
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../controllers/youtubeClient', () => ({ getYouTubeClient: jest.fn() }));
const { getYouTubeClient } = require('../controllers/youtubeClient');

const app = require('../app');
const youtubeProvider = require('../providers/youtube');
const customProvider = require('../providers/custom');
const { getProvider, listProviders } = require('../providers');
const { makePlaylist, makeTrack, likedPlaylist } = require('../providers/normalize');
const scClient = require('../controllers/soundcloud/client');
const scTokens = require('../controllers/soundcloud/tokens');
const ytdlp = require('../controllers/soundcloud/ytdlp');

const validToken = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${validToken}` };

const FRESH = { access_token: 'yt-token', expires_at: Date.now() + 60 * 60 * 1000 };
const EXPIRED = { access_token: 'yt-token', expires_at: Date.now() - 1000 };

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

const googleError = (code, reason) => Object.assign(new Error(`google ${code}`), { code, errors: reason ? [{ reason }] : [] });

beforeEach(() => {
    jest.clearAllMocks();
    app.locals.db = { get: jest.fn(), all: jest.fn(), run: jest.fn().mockResolvedValue({}) };
    scTokens._resetCaches();
    scClient.http.fetch = jest.fn();
    scClient.http.sleep = jest.fn().mockResolvedValue(undefined);
    ytdlp.runner.exec = jest.fn();
    // Make SoundCloud deterministically "unconfigured" unless a test opts in.
    delete process.env.SOUNDCLOUD_CLIENT_ID;
    delete process.env.SOUNDCLOUD_CLIENT_SECRET;
    process.env.SOUNDCLOUD_PROVIDER = 'auto';
});

// --- Shapes -----------------------------------------------------------------

describe('Normalised shapes', () => {
    it('makePlaylist fills every field and coerces the id to a string', () => {
        expect(makePlaylist({ source: 'x', id: 12, name: 'N' })).toEqual({
            source: 'x', id: '12', kind: 'playlist', name: 'N', thumbnail: null, itemCount: null, readOnly: true
        });
        expect(makePlaylist({ source: 'x', id: 'a', kind: 'bogus', name: 'N' }).kind).toBe('playlist');
    });

    it('makeTrack fills every field and rounds the duration', () => {
        expect(makeTrack({ source: 'x', id: 7, title: 'T', durationSec: 12.6 })).toEqual({
            source: 'x', id: '7', title: 'T', artist: null, album: null, durationSec: 13, thumbnail: null, isrc: null, preview: false
        });
    });

    it('likedPlaylist is the pinned virtual playlist with id "liked"', () => {
        expect(likedPlaylist('youtube')).toMatchObject({ source: 'youtube', id: 'liked', kind: 'liked', readOnly: true });
    });

    it('YouTube normalises ISO durations and API objects to the shared shape', () => {
        expect(youtubeProvider.parseDuration('PT1H2M3S')).toBe(3723);
        expect(youtubeProvider.parseDuration('PT45S')).toBe(45);
        const playlist = youtubeProvider.normalizePlaylist({
            id: 'PL1', snippet: { title: 'Mix', thumbnails: { high: { url: 'h.jpg' }, default: { url: 'd.jpg' } } }, contentDetails: { itemCount: 12 }
        });
        expect(playlist).toEqual({ source: 'youtube', id: 'PL1', kind: 'playlist', name: 'Mix', thumbnail: 'h.jpg', itemCount: 12, readOnly: true });
        const track = youtubeProvider.normalizeVideo({
            id: 'dQw4w9WgXcQ', snippet: { title: 'Song', channelTitle: 'Artist', thumbnails: { default: { url: 'd.jpg' } } }, contentDetails: { duration: 'PT3M25S' }
        });
        expect(track).toMatchObject({ source: 'youtube', id: 'dQw4w9WgXcQ', title: 'Song', artist: 'Artist', thumbnail: 'd.jpg', durationSec: 205, preview: false });
    });

    it('custom playlists normalise to kind custom and keep the track\'s original source', () => {
        expect(customProvider.normalizePlaylist({ id: 5, name: 'Gym', thumbnail: null, itemCount: 3 }))
            .toEqual({ source: 'custom', id: '5', kind: 'custom', name: 'Gym', thumbnail: null, itemCount: 3, readOnly: false });
        expect(customProvider.normalizeTrack({ id: 'abc', title: 'T', artist: 'A', thumbnail: null, source: 'soundcloud' }).source).toBe('soundcloud');
    });
});

// --- Registry -----------------------------------------------------------------

describe('Provider registry', () => {
    it('lists custom, youtube and soundcloud with the shared interface', () => {
        const names = listProviders().map(p => p.name);
        expect(names).toEqual(expect.arrayContaining(['custom', 'youtube', 'soundcloud']));
        for (const p of listProviders()) {
            expect(p).toEqual(expect.objectContaining({ name: expect.any(String), label: expect.any(String), capabilities: expect.any(Object), connect: expect.any(Object) }));
        }
    });

    it('declares liked only for providers that can list liked songs', () => {
        expect(getProvider('youtube').capabilities.liked).toBe(true);
        expect(getProvider('soundcloud').capabilities.liked).toBe(true);
        expect(getProvider('custom').capabilities.liked).toBe(false);
    });

    it('rejects unknown or malformed names', () => {
        expect(getProvider('spotify')).toBeNull();
        expect(getProvider('../etc')).toBeNull();
        expect(getProvider('constructor')).toBeNull();
    });
});

// --- /api/sources --------------------------------------------------------------

describe('GET /api/sources', () => {
    it('requires our login', async () => {
        expect((await request(app).get('/api/sources')).statusCode).toBe(401);
    });

    it('describes every provider and whether this user has connected it', async () => {
        app.locals.db.all.mockResolvedValueOnce([{ source_name: 'youtube', expires_at: FRESH.expires_at, refreshable: 0 }]);

        const res = await request(app).get('/api/sources').set(auth);
        expect(res.statusCode).toBe(200);
        const byName = Object.fromEntries(res.body.sources.map(s => [s.name, s]));

        expect(byName.youtube).toMatchObject({ label: 'YouTube', connected: true, connect: { required: true, kind: 'oauth', available: true }, capabilities: { liked: true, like: true, search: true } });
        expect(byName.soundcloud).toMatchObject({ connected: false, connect: { required: true, available: false } }); // no credentials in this test
        expect(byName.custom).toMatchObject({ connected: true, connect: { required: false, kind: 'none' }, capabilities: { liked: false } });
        // Scoped to the logged-in user.
        expect(app.locals.db.all.mock.calls[0][1]).toEqual([1]);
    });

    it('treats an expired YouTube token as not connected, and a refreshable SoundCloud token as connected', async () => {
        app.locals.db.all.mockResolvedValueOnce([
            { source_name: 'youtube', expires_at: EXPIRED.expires_at, refreshable: 0 },
            { source_name: 'soundcloud', expires_at: EXPIRED.expires_at, refreshable: 1 }
        ]);
        const res = await request(app).get('/api/sources').set(auth);
        const byName = Object.fromEntries(res.body.sources.map(s => [s.name, s]));
        expect(byName.youtube.connected).toBe(false);
        expect(byName.soundcloud.connected).toBe(true);
    });

    it('keeps an expired YouTube connection connected when the server can renew it', async () => {
        app.locals.db.all.mockResolvedValueOnce([
            { source_name: 'youtube', expires_at: EXPIRED.expires_at, refreshable: 1 }
        ]);
        const res = await request(app).get('/api/sources').set(auth);
        const byName = Object.fromEntries(res.body.sources.map(s => [s.name, s]));
        expect(byName.youtube.connected).toBe(true);
    });

    it('says which sources need a connection to search (SoundCloud searches public tracks without one)', async () => {
        app.locals.db.all.mockResolvedValueOnce([]);
        const res = await request(app).get('/api/sources').set(auth);
        const byName = Object.fromEntries(res.body.sources.map(s => [s.name, s]));
        expect(byName.youtube.searchRequiresConnection).toBe(true);
        expect(byName.soundcloud.searchRequiresConnection).toBe(false);
        expect(byName.custom.searchRequiresConnection).toBe(false);
    });
});

// --- Per-source token errors -------------------------------------------------------

describe('sourceToken: per-source not-connected and expired codes', () => {
    it('returns 401 SOURCE_NOT_CONNECTED with the source name when nothing is stored', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/api/library/youtube/playlists').set(auth);
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ code: 'SOURCE_NOT_CONNECTED', source: 'youtube' });
    });

    it('returns 401 SOURCE_TOKEN_EXPIRED when the stored token is past its expiry', async () => {
        app.locals.db.get.mockResolvedValueOnce(EXPIRED);
        const res = await request(app).get('/api/library/youtube/playlists').set(auth);
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ code: 'SOURCE_TOKEN_EXPIRED', source: 'youtube' });
    });

    it('looks the connection up for the token userId, never client input', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        await request(app).get('/api/library/youtube/playlists').set(auth).set('x-user-id', '999');
        expect(app.locals.db.get.mock.calls[0][1][0]).toBe(1);
    });

    it('returns 404 SOURCE_UNKNOWN for a source that has no provider', async () => {
        const res = await request(app).get('/api/library/napster/playlists').set(auth);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('SOURCE_UNKNOWN');
    });

    it('the legacy /search alias emits the unified SOURCE_* code with its source', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/search?q=x').set(auth);
        expect(res.statusCode).toBe(401);
        // Stage 3 unified every route on SOURCE_* codes (the client no longer
        // reads the old GOOGLE_* ones), so the alias answers like the rest.
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
        expect(res.body.source).toBe('youtube');
    });
});

// --- YouTube library ---------------------------------------------------------------

describe('YouTube library through the generic routes', () => {
    beforeEach(() => app.locals.db.get.mockResolvedValue(FRESH));

    it('lists playlists in the shared shape with the liked playlist pinned first and a cursor', async () => {
        const yt = fakeYouTube();
        yt.playlists.list.mockResolvedValueOnce({ data: {
            items: [{ id: 'PL1', snippet: { title: 'Mix', thumbnails: { high: { url: 'h.jpg' } } }, contentDetails: { itemCount: 12 } }],
            nextPageToken: 'PAGE2'
        } });

        const res = await request(app).get('/api/library/youtube/playlists').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items[0]).toMatchObject({ id: 'liked', kind: 'liked', source: 'youtube' });
        expect(res.body.items[1]).toEqual({ source: 'youtube', id: 'PL1', kind: 'playlist', name: 'Mix', thumbnail: 'h.jpg', itemCount: 12, readOnly: true });
        expect(res.body.nextCursor).toBe('PAGE2');
        expect(yt.playlists.list.mock.calls[0][0]).toMatchObject({ mine: true, pageToken: undefined });
    });

    it('round-trips the cursor as pageToken and does not re-pin liked on later pages', async () => {
        const yt = fakeYouTube();
        yt.playlists.list.mockResolvedValueOnce({ data: { items: [], nextPageToken: undefined } });

        const res = await request(app).get('/api/library/youtube/playlists?cursor=PAGE2').set(auth);

        expect(res.statusCode).toBe(200);
        expect(yt.playlists.list.mock.calls[0][0].pageToken).toBe('PAGE2');
        expect(res.body.items).toEqual([]);
        expect(res.body.nextCursor).toBeNull();
    });

    it('routes the liked playlist to videos.list myRating=like, keeps only music, and normalises', async () => {
        const yt = fakeYouTube();
        yt.videos.list.mockResolvedValueOnce({ data: {
            items: [
                { id: 'dQw4w9WgXcQ', snippet: { title: 'Song', channelTitle: 'Artist', categoryId: '10', thumbnails: { default: { url: 'd.jpg' } } }, contentDetails: { duration: 'PT3M25S' } },
                { id: 'notmusic123', snippet: { title: 'Vlog', channelTitle: 'X', categoryId: '22', thumbnails: {} }, contentDetails: { duration: 'PT1M' } }
            ],
            nextPageToken: 'L2'
        } });

        const res = await request(app).get('/api/library/youtube/playlists/liked/tracks').set(auth);

        expect(res.statusCode).toBe(200);
        expect(yt.videos.list.mock.calls[0][0]).toMatchObject({ myRating: 'like' });
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0]).toMatchObject({ source: 'youtube', id: 'dQw4w9WgXcQ', title: 'Song', artist: 'Artist', durationSec: 205, preview: false });
        expect(res.body.nextCursor).toBe('L2');
    });

    it('lists playlist tracks, dropping deleted videos that have no resourceId', async () => {
        const yt = fakeYouTube();
        yt.playlistItems.list.mockResolvedValueOnce({ data: {
            items: [
                { snippet: { title: 'A', videoOwnerChannelTitle: 'Owner', resourceId: { videoId: 'aaaaaaaaaaa' }, thumbnails: { high: { url: 'a.jpg' } } } },
                { snippet: { title: 'Deleted video', thumbnails: {} } }
            ]
        } });

        const res = await request(app).get('/api/library/youtube/playlists/PL1/tracks').set(auth);

        expect(res.statusCode).toBe(200);
        expect(yt.playlistItems.list.mock.calls[0][0]).toMatchObject({ playlistId: 'PL1' });
        expect(res.body.items).toEqual([expect.objectContaining({ id: 'aaaaaaaaaaa', artist: 'Owner', thumbnail: 'a.jpg', durationSec: null })]);
        expect(res.body.nextCursor).toBeNull();
    });

    it('likes and unlikes through videos.rate', async () => {
        const yt = fakeYouTube();
        const like = await request(app).post('/api/library/youtube/liked').set(auth).send({ trackId: 'dQw4w9WgXcQ' });
        expect(like.statusCode).toBe(204);
        expect(yt.videos.rate).toHaveBeenCalledWith({ id: 'dQw4w9WgXcQ', rating: 'like' });

        const unlike = await request(app).delete('/api/library/youtube/liked/dQw4w9WgXcQ').set(auth);
        expect(unlike.statusCode).toBe(204);
        expect(yt.videos.rate).toHaveBeenCalledWith({ id: 'dQw4w9WgXcQ', rating: 'none' });
    });

    it('asks for the write scope when Google refuses the like for lack of permission', async () => {
        const yt = fakeYouTube();
        yt.videos.rate.mockRejectedValueOnce(googleError(403, 'insufficientPermissions'));

        const res = await request(app).post('/api/library/youtube/liked').set(auth).send({ trackId: 'dQw4w9WgXcQ' });

        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ code: 'SOURCE_SCOPE_REQUIRED', source: 'youtube', scope: 'write' });
    });

    it('maps a Google 401 to SOURCE_TOKEN_EXPIRED and a quota 403 to SOURCE_RATE_LIMITED', async () => {
        const yt = fakeYouTube();
        yt.playlists.list.mockRejectedValueOnce(googleError(401));
        expect((await request(app).get('/api/library/youtube/playlists').set(auth)).body.code).toBe('SOURCE_TOKEN_EXPIRED');

        yt.playlists.list.mockRejectedValueOnce(googleError(403, 'quotaExceeded'));
        const limited = await request(app).get('/api/library/youtube/playlists').set(auth);
        expect(limited.statusCode).toBe(429);
        expect(limited.body.code).toBe('SOURCE_RATE_LIMITED');
    });

    it('rejects a malformed track id before calling Google', async () => {
        const yt = fakeYouTube();
        const res = await request(app).post('/api/library/youtube/liked').set(auth).send({ trackId: '../x' });
        expect(res.statusCode).toBe(404);
        expect(yt.videos.rate).not.toHaveBeenCalled();
    });
});

// --- Custom library -----------------------------------------------------------------

describe('Custom playlists through the generic routes', () => {
    it('lists the user\'s playlists as kind custom with no liked playlist', async () => {
        app.locals.db.all.mockResolvedValueOnce([{ id: 5, name: 'Gym', thumbnail: null, itemCount: 3 }]);

        const res = await request(app).get('/api/library/custom/playlists').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items).toEqual([{ source: 'custom', id: '5', kind: 'custom', name: 'Gym', thumbnail: null, itemCount: 3, readOnly: false }]);
        expect(res.body.nextCursor).toBeNull();
        expect(app.locals.db.all.mock.calls[0][1][0]).toBe(1); // scoped to the user
    });

    it('pages by row id: returns 50 and a cursor when there are more', async () => {
        const rows = Array.from({ length: 51 }, (_, i) => ({ id: 100 - i, name: `P${i}`, thumbnail: null, itemCount: 0 }));
        app.locals.db.all.mockResolvedValueOnce(rows);

        const res = await request(app).get('/api/library/custom/playlists').set(auth);

        expect(res.body.items).toHaveLength(50);
        expect(res.body.nextCursor).toBe('51'); // id of the 50th row; the next page starts below it

        app.locals.db.all.mockResolvedValueOnce([]);
        await request(app).get('/api/library/custom/playlists?cursor=51').set(auth);
        expect(app.locals.db.all.mock.calls[1][1]).toEqual([1, 51, 51, 51]);
    });

    it('lists tracks with each track\'s original source, only for playlists the user owns', async () => {
        app.locals.db.get.mockResolvedValueOnce({ id: 5 }); // ownership
        app.locals.db.all.mockResolvedValueOnce([
            { rowId: 1, id: 'dQw4w9WgXcQ', title: 'A', artist: 'X', thumbnail: null, source: 'youtube' },
            { rowId: 2, id: '123', title: 'B', artist: 'Y', thumbnail: null, source: 'soundcloud' }
        ]);

        const res = await request(app).get('/api/library/custom/playlists/5/tracks').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.items.map(t => t.source)).toEqual(['youtube', 'soundcloud']);
        expect(res.body.items[0]).toMatchObject({ id: 'dQw4w9WgXcQ', title: 'A', artist: 'X', durationSec: null });

        app.locals.db.get.mockResolvedValueOnce(undefined); // not owned
        const denied = await request(app).get('/api/library/custom/playlists/5/tracks').set(auth);
        expect(denied.statusCode).toBe(404);
        expect(denied.body.code).toBe('SOURCE_NOT_FOUND');
    });

    it('reports liking as unsupported and rejects a malformed cursor', async () => {
        const like = await request(app).post('/api/library/custom/liked').set(auth).send({ trackId: 'x' });
        expect(like.statusCode).toBe(404);
        expect(like.body.code).toBe('SOURCE_NOT_SUPPORTED');

        const liked = await request(app).get('/api/library/custom/playlists/liked/tracks').set(auth);
        expect(liked.body.code).toBe('SOURCE_NOT_SUPPORTED');

        const bad = await request(app).get('/api/library/custom/playlists?cursor=abc').set(auth);
        expect(bad.statusCode).toBe(400);
        expect(bad.body.code).toBe('SOURCE_BAD_CURSOR');
    });
});

// --- Generic search -----------------------------------------------------------------

describe('GET /api/search/:source', () => {
    it('YouTube search needs the user\'s connection', async () => {
        app.locals.db.get.mockResolvedValueOnce(undefined);
        const res = await request(app).get('/api/search/youtube?q=hello').set(auth);
        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ code: 'SOURCE_NOT_CONNECTED', source: 'youtube' });
    });

    it('YouTube search returns normalised tracks with durations and a cursor', async () => {
        app.locals.db.get.mockResolvedValue(FRESH);
        const yt = fakeYouTube();
        yt.search.list.mockResolvedValueOnce({ data: { items: [{ id: { videoId: 'dQw4w9WgXcQ' } }], nextPageToken: 'S2' } });
        yt.videos.list.mockResolvedValueOnce({ data: { items: [{ id: 'dQw4w9WgXcQ', snippet: { title: 'Song', channelTitle: 'Artist', thumbnails: {} }, contentDetails: { duration: 'PT2M' } }] } });

        const res = await request(app).get('/api/search/youtube?q=hello').set(auth);

        expect(res.statusCode).toBe(200);
        expect(yt.search.list.mock.calls[0][0]).toMatchObject({ q: 'hello', type: 'video' });
        expect(res.body.items[0]).toMatchObject({ source: 'youtube', id: 'dQw4w9WgXcQ', durationSec: 120 });
        expect(res.body.nextCursor).toBe('S2');
    });

    it('SoundCloud search works without a connection, through yt-dlp when unconfigured', async () => {
        app.locals.db.get.mockResolvedValue(undefined); // not connected; no app token
        ytdlp.runner.exec.mockResolvedValueOnce(JSON.stringify({ id: '11', title: 'One', uploader: 'u', duration: 200, webpage_url: 'https://soundcloud.com/u/11', thumbnails: [] }) + '\n');

        const res = await request(app).get('/api/search/soundcloud?q=hello').set(auth);

        expect(res.statusCode).toBe(200);
        expect(res.body.provider).toBe('ytdlp');
        expect(res.body.items[0]).toMatchObject({ source: 'soundcloud', id: '11', title: 'One', durationSec: 200 });
        expect(res.body.nextCursor).toBeNull();
        expect(scClient.http.fetch).not.toHaveBeenCalled();
    });

    it('custom has no search', async () => {
        const res = await request(app).get('/api/search/custom?q=x').set(auth);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('SOURCE_NOT_SUPPORTED');
    });
});

describe('custom provider keeps the per-user metadata fix (security review 2026-11-08)', () => {
    it('reads playlist rows through the per-user columns, not the shared tracks row', async () => {
        const custom = require('../providers/custom');
        const db = {
            get: jest.fn().mockResolvedValue({ id: 5 }),
            all: jest.fn().mockResolvedValue([])
        };
        await custom.getPlaylistTracks({ db, userId: 1 }, '5', {});
        const sql = db.all.mock.calls.map((c) => c[0]).join('\n');
        expect(sql).toContain('COALESCE(pt.title, t.title)');
        expect(sql).not.toMatch(/t\.external_id AS id, t\.title, t\.artist, t\.thumbnail/);
    });
});
