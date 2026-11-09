// End-to-end: the REAL normalize, score, innertube, ytsearch and engine
// modules wired together against a real in-memory SQLite, fed the real
// YouTube Music / yt-dlp responses captured in tests/fixtures/. Only the two
// network seams are stubbed (innertube.http.fetch and ytsearch.runner.exec),
// so this is the spec's Acceptance list proven on the code that ships, not on
// the per-module fakes the unit suites use.
const fs = require('fs');
const path = require('path');

// The registry pulls in every provider (and googleapis); no provider declares
// match-mode playback yet, so a stub keeps this suite about the matcher.
jest.mock('../providers', () => ({ listProviders: jest.fn(() => []) }));

const initDB = require('../config/db');
const innertube = require('../services/matcher/innertube');
const ytsearch = require('../services/matcher/ytsearch');
const { evaluate } = require('../services/matcher/score');
const matcher = require('../services/matcher');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SONGS = fixture('innertube-search.json');
const VIDEOS = fixture('innertube-videos.json');
const KHRUANGBIN_SONGS = fixture('innertube-songs-khruangbin.json');
const YTSEARCH_FLAT = fixture('ytsearch-flat.jsonl');

// Spotify's catalog entries, as the Spotify provider will deliver them.
const DAFT_PUNK = ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'];
const ALBUM_TRACK = {
    source: 'spotify',
    id: '2Foc5Q5nqNiosCNqttzHof',
    title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)',
    artist: 'Daft Punk',
    artists: DAFT_PUNK,
    album: 'Random Access Memories',
    durationSec: 369
};
const RADIO_EDIT = {
    source: 'spotify',
    id: '69kOkLUCkxIZYexIgSG8rq',
    title: 'Get Lucky (Radio Edit) [feat. Pharrell Williams & Nile Rodgers]',
    artist: 'Daft Punk',
    artists: DAFT_PUNK,
    album: 'Get Lucky (Radio Edit) [feat. Pharrell Williams & Nile Rodgers]',
    durationSec: 248
};
const FUNK_PUNK = { source: 'spotify', id: 'funkpunk0000000000000', title: 'Get Lucky', artist: 'Funk Punk', album: 'Get Lucky', durationSec: 250 };
const LEO = { source: 'spotify', id: 'leo00000000000000000000', title: 'Get Lucky', artist: 'Leo', durationSec: 209 };
const MARIA = { source: 'spotify', id: 'maria000000000000000000', title: 'Maria También', artist: 'Khruangbin', album: 'Con Todo El Mundo', durationSec: 191 };
const UNKNOWN = { source: 'spotify', id: 'nothing0000000000000000', title: 'Song That Does Not Exist', artist: 'Nobody', durationSec: 200 };
const YOUTUBE_TRACK = { source: 'youtube', id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationSec: 213 };

const okResponse = (text) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => text });

// Routes each InnerTube request to the fixture captured for that filter and
// query, and records what was asked so tests can assert the query sequence.
function innertubeFromFixtures(calls) {
    return async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, query: body.query, params: body.params });
        if (body.params === innertube.VIDEOS_PARAMS) return okResponse(VIDEOS);
        if (/khruangbin/i.test(body.query)) return okResponse(KHRUANGBIN_SONGS);
        return okResponse(SONGS);
    };
}

let db;
let fetchSpy;
let execSpy;
let calls;

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
});

beforeEach(async () => {
    matcher._internals.resetForTests();
    delete process.env.MATCH_YTDLP_FALLBACK;
    delete process.env.MATCH_YTDLP_RECALL;
    db = await initDB(':memory:');
    calls = [];
    fetchSpy = jest.spyOn(innertube.http, 'fetch').mockImplementation(innertubeFromFixtures(calls));
    // yt-dlp must never run unless a test turns InnerTube off: a rejection
    // here makes an unexpected fallback visible as a failed assertion.
    execSpy = jest.spyOn(ytsearch.runner, 'exec').mockRejectedValue(new Error('yt-dlp must not be spawned in this test'));
});

afterEach(async () => {
    fetchSpy.mockRestore();
    execSpy.mockRestore();
    await db.close();
});

describe('Acceptance: Daft Punk "Get Lucky" against the real YouTube Music songs response', () => {
    it('matches the 369 s album track to the catalog album entry 4D7u5KF7SP8', async () => {
        const result = await matcher.resolve(db, ALBUM_TRACK);

        expect(result).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8', method: 'ytmusic', fromCache: false });
        expect(result.score).toBeGreaterThanOrEqual(90);
        // Only the songs filter was needed: the first query already passed.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ query: 'Daft Punk Get Lucky (feat. Pharrell Williams & Nile Rodgers)', params: innertube.SONGS_PARAMS });
        expect(calls[0].url).toMatch(/^https:\/\/music\.youtube\.com\/youtubei\/v1\/search/);

        // The radio edit is the same song but a different recording: kept as
        // a candidate for the report UI, rejected on variant and duration.
        const radio = result.candidates.find((c) => c.videoId === 'Rgrt_8mXrK8');
        expect(radio).toMatchObject({ ok: false });
        expect(radio.reasons).toEqual(expect.arrayContaining(['title', 'duration']));
        expect(result.candidates.length).toBeLessThanOrEqual(5);
        expect(result.candidates[0]).toMatchObject({ videoId: '4D7u5KF7SP8', ok: true, reasons: [] });
    });

    it('matches the 248 s radio edit to Rgrt_8mXrK8 from the songs filter alone', async () => {
        const result = await matcher.resolve(db, RADIO_EDIT);

        expect(result).toMatchObject({ status: 'matched', videoId: 'Rgrt_8mXrK8', method: 'ytmusic' });
        expect(result.score).toBeGreaterThanOrEqual(90);
        // No videos-filter fallback was necessary for the radio edit.
        expect(calls.map((c) => c.params)).toEqual([innertube.SONGS_PARAMS]);
        // The album version is a different recording for the radio edit, too.
        const album = result.candidates.find((c) => c.videoId === '4D7u5KF7SP8');
        expect(album.ok).toBe(false);
        expect(album.reasons).toContain('title');
    });

    it('keeps the two Spotify entries on their own recordings (never swapped)', async () => {
        const album = await matcher.resolve(db, ALBUM_TRACK);
        const radio = await matcher.resolve(db, RADIO_EDIT);
        expect(album.videoId).toBe('4D7u5KF7SP8');
        expect(radio.videoId).toBe('Rgrt_8mXrK8');
        expect(album.videoId).not.toBe(radio.videoId);
    });
});

describe('Acceptance: artist and variant rules on real candidates', () => {
    it('"Get Lucky" by Funk Punk matches the Funk Punk entry 2KPIShmFouY', async () => {
        const result = await matcher.resolve(db, FUNK_PUNK);
        expect(result).toMatchObject({ status: 'matched', videoId: '2KPIShmFouY', method: 'ytmusic' });
        // Daft Punk's recordings are rejected for Funk Punk on artist.
        for (const id of ['Rgrt_8mXrK8', '4D7u5KF7SP8']) {
            const c = result.candidates.find((x) => x.videoId === id);
            expect(c).toBeDefined();
            expect(c.ok).toBe(false);
            expect(c.reasons).toContain('artist');
        }
    });

    it('Daft Punk\'s track never matches Funk Punk\'s entry', async () => {
        const parsed = innertube.parseResults(JSON.parse(SONGS));
        const funkPunk = parsed.find((c) => c.videoId === '2KPIShmFouY');
        expect(funkPunk).toMatchObject({ artists: ['Funk Punk'], videoType: 'atv' });

        for (const track of [ALBUM_TRACK, RADIO_EDIT]) {
            const verdict = evaluate(track, funkPunk);
            expect(verdict.ok).toBe(false);
            expect(verdict.reasons).toContain('artist');
            const result = await matcher.resolve(db, track);
            expect(result.videoId).not.toBe('2KPIShmFouY');
        }
    });

    it('rejects the Metal Cover on variant even for an artist who matches', async () => {
        // Leo's cover is the only Leo entry; it fails on nothing but the
        // "(Metal Cover)" variant, so Leo's plain "Get Lucky" stays unmatched.
        const result = await matcher.resolve(db, LEO);
        expect(result.status).toBe('not_found');
        expect(result.videoId).toBeNull();
        const cover = result.candidates.find((c) => c.videoId === 'D-cfH1V4RQ0');
        expect(cover).toMatchObject({ ok: false, reasons: ['title'] });

        // For Daft Punk the cover is wrong on every axis.
        const parsed = innertube.parseResults(JSON.parse(SONGS));
        const coverCandidate = parsed.find((c) => c.videoId === 'D-cfH1V4RQ0');
        const verdict = evaluate(RADIO_EDIT, coverCandidate);
        expect(verdict.ok).toBe(false);
        expect(verdict.reasons).toEqual(expect.arrayContaining(['artist', 'title']));
    });

    it('matches an accented title through the raw query (Khruangbin "Maria También")', async () => {
        const result = await matcher.resolve(db, MARIA);
        expect(result).toMatchObject({ status: 'matched', videoId: 'olf4IO9Dx4E', method: 'ytmusic' });
        // The query keeps the accent: the probe showed the stripped form misses the song.
        expect(calls[0].query).toBe('Khruangbin Maria También');
    });
});

describe('Acceptance: no acceptable candidate', () => {
    it('becomes not_found after the songs and videos filters, without spawning yt-dlp', async () => {
        const result = await matcher.resolve(db, UNKNOWN);

        expect(result).toMatchObject({ status: 'not_found', videoId: null, score: null, method: null, fromCache: false });
        // Songs artist-first, then title-first, then videos; the core query is
        // skipped because the bare title has no qualifiers to strip.
        expect(calls.map((c) => c.params)).toEqual([innertube.SONGS_PARAMS, innertube.SONGS_PARAMS, innertube.VIDEOS_PARAMS]);
        expect(calls.map((c) => c.query)).toEqual(['Nobody Song That Does Not Exist', 'song that does not exist Nobody', 'Nobody Song That Does Not Exist']);
        expect(execSpy).not.toHaveBeenCalled();
        // The OMV from the videos response was considered and rejected; the
        // UGC uploads never reach scoring.
        expect(result.candidates.some((c) => c.videoId === '5NV6Rdv1a3I')).toBe(true);
        expect(result.candidates.every((c) => c.ok === false)).toBe(true);
        expect(result.candidates.some((c) => c.videoId === 'CCHdMIEGaaM')).toBe(false);

        const row = await matcher.getMatch(db, 'spotify', UNKNOWN.id);
        expect(row).toMatchObject({ status: 'not_found', videoId: null, manual: false });
    });

    it('is hidden by filterPlayable while matched tracks gain youtubeId and a youtube track passes through untouched', async () => {
        const list = [YOUTUBE_TRACK, ALBUM_TRACK, UNKNOWN, RADIO_EDIT, FUNK_PUNK];
        const { items, summary } = await matcher.filterPlayable(db, list);

        expect(summary).toEqual({ total: 4, matched: 3, hidden: 1, pending: 0, errors: 0 });
        expect(items.map((t) => t.id)).toEqual([YOUTUBE_TRACK.id, ALBUM_TRACK.id, RADIO_EDIT.id, FUNK_PUNK.id]);
        // The non-match-mode track is the very same object, not a copy.
        expect(items[0]).toBe(YOUTUBE_TRACK);
        expect(items[0]).not.toHaveProperty('youtubeId');

        expect(items[1]).toMatchObject({ ...ALBUM_TRACK, youtubeId: '4D7u5KF7SP8', match: { status: 'matched', method: 'ytmusic' } });
        expect(items[2]).toMatchObject({ ...RADIO_EDIT, youtubeId: 'Rgrt_8mXrK8', match: { status: 'matched', method: 'ytmusic' } });
        expect(items[3]).toMatchObject({ ...FUNK_PUNK, youtubeId: '2KPIShmFouY' });
        expect(items.some((t) => t.id === UNKNOWN.id)).toBe(false);
        // Inputs are never mutated.
        expect(ALBUM_TRACK).not.toHaveProperty('youtubeId');
        expect(execSpy).not.toHaveBeenCalled();
    });

    it('a second filterPlayable over the same list is served from the table', async () => {
        await matcher.filterPlayable(db, [ALBUM_TRACK, UNKNOWN]);
        const before = fetchSpy.mock.calls.length;
        const { items, summary } = await matcher.filterPlayable(db, [ALBUM_TRACK, UNKNOWN, YOUTUBE_TRACK]);
        expect(fetchSpy.mock.calls.length).toBe(before);
        expect(summary).toEqual({ total: 2, matched: 1, hidden: 1, pending: 0, errors: 0 });
        expect(items.map((t) => t.id)).toEqual([ALBUM_TRACK.id, YOUTUBE_TRACK.id]);
    });
});

describe('Acceptance: a full resolve is cached', () => {
    it('answers the second resolve from the table without touching the network', async () => {
        const first = await matcher.resolve(db, ALBUM_TRACK);
        expect(first.fromCache).toBe(false);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const second = await matcher.resolve(db, ALBUM_TRACK);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(second).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8', score: first.score, method: 'ytmusic', fromCache: true });
        expect(second.candidates.map((c) => c.videoId)).toEqual(first.candidates.map((c) => c.videoId));

        const row = await matcher.getMatch(db, 'spotify', ALBUM_TRACK.id);
        expect(row).toMatchObject({ source: 'spotify', externalId: ALBUM_TRACK.id, status: 'matched', videoId: '4D7u5KF7SP8', method: 'ytmusic', manual: false });
        expect(typeof row.checkedAt).toBe('number');
    });

    it('resolveMany shares one search per track across concurrent asks', async () => {
        const [a, b] = await Promise.all([
            matcher.resolveMany(db, [ALBUM_TRACK, RADIO_EDIT]),
            matcher.resolveMany(db, [RADIO_EDIT, ALBUM_TRACK])
        ]);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(a.get(matcher.keyOf(ALBUM_TRACK)).videoId).toBe('4D7u5KF7SP8');
        expect(a.get(matcher.keyOf(RADIO_EDIT)).videoId).toBe('Rgrt_8mXrK8');
        expect(b.get(matcher.keyOf(ALBUM_TRACK)).videoId).toBe('4D7u5KF7SP8');
        expect(b.get(matcher.keyOf(RADIO_EDIT)).videoId).toBe('Rgrt_8mXrK8');
    });
});

describe('yt-dlp fallback with the real flat-search response', () => {
    const SINGLE_249 = { ...ALBUM_TRACK, id: 'single00000000000000000', durationSec: 249 };

    beforeEach(() => {
        fetchSpy.mockImplementation(async () => { throw new TypeError('fetch failed'); });
        execSpy.mockImplementation(async (args) => { calls.push({ exec: args }); return YTSEARCH_FLAT; });
    });

    it('matches the verified artist channel upload when InnerTube is down', async () => {
        const result = await matcher.resolve(db, SINGLE_249);

        expect(result).toMatchObject({ status: 'matched', videoId: '5NV6Rdv1a3I', method: 'ytsearch', fromCache: false });
        expect(execSpy).toHaveBeenCalledTimes(1);
        // The bare title is searched: no YouTube title carries Spotify's
        // "(feat. Pharrell Williams & Nile Rodgers)" verbatim as a phrase.
        expect(execSpy.mock.calls[0][0]).toEqual([
            '--no-update', '--no-warnings', '--flat-playlist', '-j',
            'ytsearch10:"Daft Punk" "get lucky"'
        ]);
        // The verified lyric channel and the unverified re-uploads are private
        // uploads under the channel rule, however many views they have.
        const lyric = result.candidates.find((c) => c.videoId === '5glDAaCaazc');
        expect(lyric).toMatchObject({ ok: false });
        expect(lyric.reasons).toEqual(expect.arrayContaining(['unofficial', 'artist']));
        expect(result.candidates.filter((c) => c.ok)).toHaveLength(1);
    });

    it('rejects the unverified 369 s re-upload and records an error to retry later', async () => {
        const result = await matcher.resolve(db, ALBUM_TRACK);

        // Only the primary source could have answered; the fallback found no
        // official upload of the album version, so this is an error (retried
        // after MATCH_ERROR_TTL_MS), not a definitive not_found.
        expect(result).toMatchObject({ status: 'error', videoId: null, method: null });
        const reupload = result.candidates.find((c) => c.videoId === 'DvE7O3bLQgE');
        expect(reupload).toMatchObject({ ok: false, durationSec: 369 });
        expect(reupload.reasons).toEqual(expect.arrayContaining(['unofficial', 'artist']));
        expect(result.candidates.every((c) => c.ok === false)).toBe(true);
    });

    it('does not run when MATCH_YTDLP_FALLBACK=off', async () => {
        process.env.MATCH_YTDLP_FALLBACK = 'off';
        const result = await matcher.resolve(db, SINGLE_249);
        expect(result.status).toBe('error');
        expect(execSpy).not.toHaveBeenCalled();
    });
});
