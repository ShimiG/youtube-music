// The match engine against a real in-memory SQLite: the cache policy, ISRC
// reuse, overrides, in-flight de-duplication, the two queues, the request
// budget, filterPlayable and the yt-dlp fallback rules.
//
// The network modules are mocked. normalize/score are mocked too: this file is
// about the engine, and the text rules have their own suites. The real
// modules wired together run in tests/matcher.e2e.test.js.
jest.mock('../services/matcher/innertube', () => ({
    searchSongs: jest.fn(),
    searchVideos: jest.fn(),
    // The engine builds its own back-off and backlog errors with the real class.
    MatchSourceError: jest.requireActual('../services/matcher/innertube').MatchSourceError
}));

jest.mock('../services/matcher/ytsearch', () => ({
    searchVideos: jest.fn(),
    isEnabled: () => !['off', 'false', '0'].includes(String(process.env.MATCH_YTDLP_FALLBACK ?? 'on').toLowerCase()),
    recallEnabled: () => ['true', '1', 'on'].includes(String(process.env.MATCH_YTDLP_RECALL ?? 'false').toLowerCase())
}));

jest.mock('../services/matcher/normalize', () => {
    const normalizeText = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const artistsOf = (track) => (Array.isArray(track.artists) && track.artists.length ? track.artists : [track.artist].filter(Boolean));
    return {
        normalizeText,
        artistsOf,
        primaryArtist: (track) => artistsOf(track)[0] || null,
        // Just enough of the real rule for the query sequence: brackets hold qualifiers.
        parseTitle: (title) => ({ core: normalizeText(String(title || '').replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')), variants: new Set(), feats: [] })
    };
});

// A candidate passes unless it carries `ok: false`; its score is `score` or 90.
// Named (and `mock`-prefixed, so the hoisted factory may reference it) because
// beforeEach resets every mock and has to re-install it.
function mockPickBest(track, candidates, { evaluated = [] } = {}) {
    const fresh = candidates.map((c) => (c.ok === false
        ? { ...c, ok: false, reasons: c.reasons || ['title'], score: null }
        : { ...c, ok: true, reasons: [], score: c.score === undefined ? 90 : c.score }));
    const ranked = [...evaluated, ...fresh]
        .sort((a, b) => Number(b.ok) - Number(a.ok) || (b.score || 0) - (a.score || 0));
    return { best: ranked.find((e) => e.ok) || null, evaluated: ranked };
}

jest.mock('../services/matcher/score', () => ({
    evaluate: jest.fn(),
    durationTolerance: () => 3,
    pickBest: jest.fn(mockPickBest)
}));

jest.mock('../providers', () => ({ listProviders: jest.fn(() => []) }));

const initDB = require('../config/db');
const innertube = require('../services/matcher/innertube');
const ytsearch = require('../services/matcher/ytsearch');
const score = require('../services/matcher/score');
const { listProviders } = require('../providers');
const matcher = require('../services/matcher');

const { resolve, resolveMany, filterPlayable, getMatch, setOverride, markUnavailable, report, forget, isMatchSource, matchSources, keyOf, _internals } = matcher;

const ENV_VARS = ['MATCH_CONCURRENCY', 'MATCH_REQUEST_BUDGET_MS', 'MATCH_NOT_FOUND_TTL_MS', 'MATCH_ERROR_TTL_MS', 'MATCH_YTDLP_FALLBACK', 'MATCH_YTDLP_RECALL'];

// Request budget for the "pending" tests: wide enough that the tracks meant
// to finish (a stubbed search plus two SQLite round-trips) always do, even on
// a loaded machine, while a deferred search stays pending for as long as the
// test wants.
const BUDGET_MS = 1000;

const V1 = 'aaaaaaaaaaa';
const V2 = 'bbbbbbbbbbb';
const V3 = 'ccccccccccc';
const MANUAL = 'mmmmmmmmmmm';

const track = (id, extra = {}) => ({ source: 'spotify', id, title: `Song ${id}`, artist: 'Artist', album: null, durationSec: 200, thumbnail: null, isrc: null, preview: false, ...extra });
const cand = (videoId, extra = {}) => ({ videoId, title: 'Song', artists: ['Artist'], album: null, durationSec: 200, plays: 1, videoType: 'atv', origin: 'ytmusic', ...extra });
const ytCand = (videoId, extra = {}) => cand(videoId, { origin: 'ytsearch', videoType: undefined, channel: 'Artist - Topic', channelIsVerified: false, isTopic: true, ...extra });

function deferred() {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    return { promise, resolve: resolveFn, reject: rejectFn };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(0);
async function until(predicate, { timeoutMs = 2000 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
        await tick();
    }
}
const sourceError = (code = 'UNAVAILABLE', extra = {}) => Object.assign(new Error(`innertube ${code}`), { code, ...extra });
const flushIo = () => new Promise((r) => globalThis.setImmediate(r));

// Drains whatever the engine is still doing before the DB is closed.
async function settleInFlight() {
    while (_internals.inFlight.size) {
        await Promise.allSettled([..._internals.inFlight.values()]);
    }
}

let db;
let logSpy;
let warnSpy;

beforeAll(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
});

beforeEach(async () => {
    // Reset, not clear: a mockResolvedValueOnce left over by a test whose
    // request outlived it would otherwise feed the next test.
    jest.resetAllMocks();
    for (const name of ENV_VARS) delete process.env[name];
    listProviders.mockReturnValue([]);
    innertube.searchSongs.mockResolvedValue([]);
    innertube.searchVideos.mockResolvedValue([]);
    ytsearch.searchVideos.mockResolvedValue([]);
    score.pickBest.mockImplementation(mockPickBest);
    _internals.resetForTests();
    db = await initDB(':memory:');
    // match_reports.user_id references users(id) and foreign keys are on.
    await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'alice', 'x')`);
});

afterEach(async () => {
    jest.useRealTimers();
    await settleInFlight();
    _internals.resetForTests();
    await db.close();
});

// --- Schema --------------------------------------------------------------------

describe('initDB', () => {
    it('accepts a filename and creates the matching tables and index', async () => {
        const tables = (await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name);
        expect(tables).toEqual(expect.arrayContaining(['sources', 'users', 'track_matches', 'match_reports']));
        const indexes = (await db.all(`SELECT name FROM sqlite_master WHERE type = 'index'`)).map((r) => r.name);
        expect(indexes).toContain('idx_track_matches_isrc');
        expect(await db.get(`SELECT id FROM sources WHERE name = 'spotify'`)).toEqual({ id: 2 });
    });

    it('keeps the (source_id, external_id) pair unique', async () => {
        await db.run(`INSERT INTO track_matches (source_id, external_id, status, checked_at) VALUES (2, 'a', 'matched', 1)`);
        await expect(db.run(`INSERT INTO track_matches (source_id, external_id, status, checked_at) VALUES (2, 'a', 'matched', 1)`)).rejects.toThrow(/UNIQUE/);
    });
});

// --- Sources -------------------------------------------------------------------

describe('isMatchSource / matchSources', () => {
    it('always lists spotify and never a direct-playback source', () => {
        expect(matchSources()).toEqual(['spotify']);
        expect(isMatchSource('spotify')).toBe(true);
        expect(isMatchSource('youtube')).toBe(false);
        expect(isMatchSource('spotify ')).toBe(false);
        expect(isMatchSource(undefined)).toBe(false);
        expect(isMatchSource({ toString: () => 'spotify' })).toBe(false);
    });

    it('merges providers that declare capabilities.playback === "match"', () => {
        listProviders.mockReturnValue([
            { name: 'tidal', capabilities: { playback: 'match' } },
            { name: 'youtube', capabilities: { playback: 'direct' } },
            { name: 'spotify', capabilities: { playback: 'match' } },
            { name: 'broken' }
        ]);
        expect(matchSources()).toEqual(['spotify', 'tidal']);
        expect(isMatchSource('tidal')).toBe(true);
        expect(isMatchSource('youtube')).toBe(false);
    });

    it('keyOf is source:id', () => {
        expect(keyOf({ source: 'spotify', id: 'abc' })).toBe('spotify:abc');
        expect(keyOf({ source: 'spotify', id: 7 })).toBe('spotify:7');
    });
});

// --- resolve: cache policy -----------------------------------------------------

describe('resolve: cache', () => {
    it('misses once, searches, persists, then hits without searching again', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1, { score: 95 }), cand(V2, { score: 80 })]);
        const first = await resolve(db, track('t1'));
        expect(first).toEqual({ status: 'matched', videoId: V1, score: 95, method: 'ytmusic', candidates: expect.any(Array), fromCache: false });
        expect(first.candidates.map((c) => c.videoId)).toEqual([V1, V2]);
        expect(first.candidates[0]).toMatchObject({ ok: true, score: 95 });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);
        expect(innertube.searchVideos).not.toHaveBeenCalled();

        const second = await resolve(db, track('t1'));
        expect(second).toEqual({ ...first, fromCache: true });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);

        const row = await getMatch(db, 'spotify', 't1');
        expect(row).toMatchObject({ source: 'spotify', externalId: 't1', status: 'matched', videoId: V1, score: 95, method: 'ytmusic', manual: false, isrc: null });
        expect(typeof row.checkedAt).toBe('number');
        expect(row.candidates).toHaveLength(2);
    });

    it('getMatch returns null when there is no row', async () => {
        expect(await getMatch(db, 'spotify', 'nope')).toBeNull();
    });

    it('stores at most five evaluated candidates, best first', async () => {
        innertube.searchSongs.mockResolvedValueOnce([1, 2, 3, 4, 5, 6, 7].map((n) => cand(`${n}`.repeat(11), { score: 50 + n })));
        const result = await resolve(db, track('many'));
        expect(result.videoId).toBe('77777777777');
        expect(result.candidates).toHaveLength(5);
        expect((await getMatch(db, 'spotify', 'many')).candidates.map((c) => c.score)).toEqual([57, 56, 55, 54, 53]);
    });

    it('rounds the score and stores it as an integer', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1, { score: 87.6 })]);
        expect((await resolve(db, track('round'))).score).toBe(88);
        expect((await db.get(`SELECT score FROM track_matches WHERE external_id = 'round'`)).score).toBe(88);
    });

    it('reuses not_found within MATCH_NOT_FOUND_TTL_MS and searches again after it', async () => {
        const first = await resolve(db, track('nf'));
        expect(first).toMatchObject({ status: 'not_found', videoId: null, method: null, fromCache: false });
        // songs(raw) -> songs(core) is skipped (nothing to strip) -> songs(reversed) -> videos(raw)
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);
        expect(innertube.searchVideos).toHaveBeenCalledTimes(1);

        expect(await resolve(db, track('nf'))).toMatchObject({ status: 'not_found', fromCache: true });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);

        // Age the row past the 30-day default.
        await db.run(`UPDATE track_matches SET checked_at = ? WHERE external_id = 'nf'`, [Date.now() - 31 * 24 * 60 * 60 * 1000]);
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        expect(await resolve(db, track('nf'))).toMatchObject({ status: 'matched', videoId: V1, fromCache: false });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(3);
    });

    it('reads MATCH_NOT_FOUND_TTL_MS at call time', async () => {
        await resolve(db, track('ttl'));
        const afterFirst = innertube.searchSongs.mock.calls.length;
        process.env.MATCH_NOT_FOUND_TTL_MS = '0';
        await resolve(db, track('ttl'));
        expect(innertube.searchSongs.mock.calls.length).toBeGreaterThan(afterFirst);
    });

    it('bounds what it parses: title, artist and album to 300 chars, artists to 20 names of 200 chars', async () => {
        const huge = track('huge', {
            title: 'T'.repeat(1024 * 1024),
            artist: 'A'.repeat(5000),
            album: 'B'.repeat(5000),
            artists: Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(1000, 'x'))
        });
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        expect(await resolve(db, huge)).toMatchObject({ status: 'matched', videoId: V1 });
        const [seen] = score.pickBest.mock.calls[0];
        expect(seen.title).toHaveLength(300);
        expect(seen.artist).toHaveLength(300);
        expect(seen.album).toHaveLength(300);
        expect(seen.artists).toHaveLength(20);
        expect(seen.artists.every((a) => a.length === 200)).toBe(true);
        // Identity is untouched: the row and the key still name the input track.
        expect(seen).toMatchObject({ source: 'spotify', id: 'huge' });
        expect(innertube.searchSongs.mock.calls[0][0]).toHaveLength(200);
        expect(await getMatch(db, 'spotify', 'huge')).toMatchObject({ videoId: V1 });
    });

    it('turns a source failure into status error, reuses it for MATCH_ERROR_TTL_MS, then retries', async () => {
        innertube.searchSongs.mockRejectedValueOnce(sourceError('UNAVAILABLE'));
        process.env.MATCH_YTDLP_FALLBACK = 'off';
        const first = await resolve(db, track('err'));
        expect(first).toEqual({ status: 'error', videoId: null, score: null, method: null, candidates: [], fromCache: false });
        expect((await getMatch(db, 'spotify', 'err')).status).toBe('error');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('spotify:err'));

        expect(await resolve(db, track('err'))).toMatchObject({ status: 'error', fromCache: true });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);

        await db.run(`UPDATE track_matches SET checked_at = ? WHERE external_id = 'err'`, [Date.now() - 11 * 60 * 1000]);
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        expect(await resolve(db, track('err'))).toMatchObject({ status: 'matched', videoId: V1 });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);
    });

    it('a crash inside scoring becomes status error rather than a rejection', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        const pickBest = score.pickBest.getMockImplementation();
        score.pickBest.mockImplementation(() => { throw new Error('boom'); });
        try {
            await expect(resolve(db, track('crash'))).resolves.toMatchObject({ status: 'error', videoId: null });
            expect((await getMatch(db, 'spotify', 'crash')).status).toBe('error');
        } finally {
            score.pickBest.mockImplementation(pickBest);
        }
    });

    it('rejects a track without a source or id', async () => {
        await expect(resolve(db, { source: 'spotify' })).rejects.toThrow(TypeError);
        await expect(resolve(db, { id: 'x' })).rejects.toThrow(TypeError);
    });

    it('fails loudly for a source that has no sources row', async () => {
        await expect(resolve(db, { source: 'nosuch', id: '1', title: 'x' })).rejects.toThrow(/sources table/);
    });

    it('caches the sources.name -> id lookup', async () => {
        const getSpy = jest.spyOn(db, 'get');
        await resolve(db, track('a'));
        await resolve(db, track('b'));
        const sourceLookups = getSpy.mock.calls.filter(([sql]) => /FROM sources/.test(sql));
        expect(sourceLookups).toHaveLength(1);
        expect(_internals.sourceIds.get('spotify')).toBe(2);
    });
});

// --- resolve: query sequence ---------------------------------------------------

describe('resolve: query sequence', () => {
    it('songs(raw) -> songs(core) -> songs(reversed) -> videos(raw), each only when nothing passed so far', async () => {
        const t = track('q', { artist: 'Daft Punk', title: 'Get Lucky (feat. Pharrell Williams)' });
        await resolve(db, t);
        expect(innertube.searchSongs.mock.calls.map(([q]) => q)).toEqual([
            'Daft Punk Get Lucky (feat. Pharrell Williams)',
            'Daft Punk get lucky',
            'get lucky Daft Punk'
        ]);
        expect(innertube.searchVideos.mock.calls.map(([q]) => q)).toEqual(['Daft Punk Get Lucky (feat. Pharrell Williams)']);
    });

    it('asks title-first when artist-first found nothing: the small act sharing a hit\'s title', async () => {
        // "Funk Punk Get Lucky" returned only Daft Punk's entries in the live
        // run; the act's own catalog song only surfaces title-first.
        innertube.searchSongs.mockImplementation(async (q) => (q === 'get lucky Funk Punk' ? [cand(V1)] : [cand(V2, { ok: false })]));
        const result = await resolve(db, track('fp', { artist: 'Funk Punk', title: 'Get Lucky' }));
        expect(result).toMatchObject({ status: 'matched', videoId: V1 });
        expect(innertube.searchSongs.mock.calls.map(([q]) => q)).toEqual(['Funk Punk Get Lucky', 'get lucky Funk Punk']);
        expect(innertube.searchVideos).not.toHaveBeenCalled();
    });

    it('skips the reversed query when it would ask nothing new', async () => {
        // No artist: raw, core and reversed collapse to the title alone.
        await resolve(db, track('noartist', { artist: null, title: 'Get Lucky (Radio Edit)' }));
        expect(innertube.searchSongs.mock.calls.map(([q]) => q)).toEqual(['Get Lucky (Radio Edit)', 'get lucky']);
        expect(innertube.searchVideos).toHaveBeenCalledTimes(1);
    });

    it('evaluates each query\'s new candidates once instead of re-scoring the whole pool', async () => {
        innertube.searchSongs
            .mockResolvedValueOnce([cand(V1, { ok: false })])
            .mockResolvedValueOnce([cand(V1, { ok: false }), cand(V2, { ok: false })]);
        await resolve(db, track('once', { title: 'Song (Live)' }));
        // One pickBest per query that produced something new, each fed only the new candidates.
        const fed = score.pickBest.mock.calls.map(([, candidates]) => candidates.map((c) => c.videoId));
        expect(fed).toEqual([[V1], [V2]]);
        expect(score.pickBest.mock.calls[1][2].evaluated.map((c) => c.videoId)).toEqual([V1]);
    });

    it('stops after the first songs query when a candidate passes', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('q', { title: 'Get Lucky (Radio Edit)' }));
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);
        expect(innertube.searchVideos).not.toHaveBeenCalled();
    });

    it('skips the core query when it would only differ by case or punctuation', async () => {
        await resolve(db, track('q', { artist: 'Khruangbin', title: 'Maria También' }));
        expect(innertube.searchSongs.mock.calls.map(([q]) => q)).toEqual(['Khruangbin Maria También', 'maria también Khruangbin']);
        expect(innertube.searchVideos).toHaveBeenCalledTimes(1);
    });

    it('uses the first of track.artists as the primary artist and caps queries at 200 chars', async () => {
        await resolve(db, track('q', { artists: ['Dua Lipa', 'DaBaby'], artist: 'Dua Lipa, DaBaby', title: 'x'.repeat(300) }));
        const [query] = innertube.searchSongs.mock.calls[0];
        expect(query.startsWith('Dua Lipa ')).toBe(true);
        expect(query).toHaveLength(200);
    });

    it('pools candidates from every query, de-duplicated by videoId, before picking', async () => {
        innertube.searchSongs
            .mockResolvedValueOnce([cand(V1, { ok: false })])
            .mockResolvedValueOnce([cand(V1, { ok: false }), cand(V2, { ok: false })]);
        innertube.searchVideos.mockResolvedValueOnce([cand(V2, { ok: false }), cand(V3, { videoType: 'omv', score: 70 })]);
        const result = await resolve(db, track('pool', { title: 'Song (Live)' }));
        expect(result).toMatchObject({ status: 'matched', videoId: V3, score: 70, method: 'ytmusic' });
        expect(result.candidates.map((c) => c.videoId)).toEqual([V3, V1, V2]);
    });

    it('a videos-filter failure after a clean songs query still counts as an InnerTube failure', async () => {
        innertube.searchSongs.mockResolvedValue([cand(V1, { ok: false })]);
        innertube.searchVideos.mockRejectedValueOnce(sourceError('UPSTREAM'));
        process.env.MATCH_YTDLP_FALLBACK = 'off';
        const result = await resolve(db, track('half', { title: 'Song (Live)' }));
        expect(result.status).toBe('error');
        // The rejected candidate is still recorded for the UI.
        expect(result.candidates).toEqual([expect.objectContaining({ videoId: V1, ok: false })]);
    });
});

// --- ISRC ----------------------------------------------------------------------

describe('resolve: ISRC reuse', () => {
    it('copies a matched sibling with the same isrc and records method isrc', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1, { score: 91 })]);
        await resolve(db, track('a', { isrc: 'USQX91300108' }));
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);

        const copy = await resolve(db, track('b', { isrc: 'USQX91300108' }));
        expect(copy).toEqual({ status: 'matched', videoId: V1, score: 91, method: 'isrc', candidates: [], fromCache: false });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);
        expect(await getMatch(db, 'spotify', 'b')).toMatchObject({ status: 'matched', videoId: V1, method: 'isrc', isrc: 'USQX91300108' });
    });

    it('prefers a manual match over an automatic one for the same isrc', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('auto', { isrc: 'X1' }));
        await setOverride(db, { source: 'spotify', externalId: 'man', videoId: MANUAL, userId: 1, isrc: 'X1' });
        expect(await resolve(db, track('c', { isrc: 'X1' }))).toMatchObject({ videoId: MANUAL, method: 'isrc' });
    });

    it('ignores siblings that are not matched', async () => {
        await resolve(db, track('nf', { isrc: 'X2' }));
        expect((await getMatch(db, 'spotify', 'nf')).status).toBe('not_found');
        innertube.searchSongs.mockResolvedValueOnce([cand(V2)]);
        expect(await resolve(db, track('d', { isrc: 'X2' }))).toMatchObject({ status: 'matched', videoId: V2, method: 'ytmusic' });
    });

    it('never copies from a row that was itself an ISRC copy', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('origin', { isrc: 'X3' }));
        expect(await resolve(db, track('copy', { isrc: 'X3' }))).toMatchObject({ videoId: V1, method: 'isrc' });
        // With the first-hand row gone, only the copy remains: it is not trusted.
        await db.run(`DELETE FROM track_matches WHERE external_id = 'origin'`);
        innertube.searchSongs.mockResolvedValueOnce([cand(V2)]);
        expect(await resolve(db, track('third', { isrc: 'X3' }))).toMatchObject({ videoId: V2, method: 'ytmusic' });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);
    });

    it('stores the matched duration and only reuses a sibling whose duration agrees', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1, { durationSec: 200 })]);
        await resolve(db, track('dur', { isrc: 'X4', durationSec: 200 }));
        expect((await db.get(`SELECT duration_sec FROM track_matches WHERE external_id = 'dur'`)).duration_sec).toBe(200);

        // Within tolerance, or with an unknown duration, the copy is fine.
        expect(await resolve(db, track('near', { isrc: 'X4', durationSec: 202 }))).toMatchObject({ videoId: V1, method: 'isrc' });
        expect(await resolve(db, track('unknown', { isrc: 'X4', durationSec: null }))).toMatchObject({ videoId: V1, method: 'isrc' });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);
        // 60 s apart: a different recording under a mislabelled ISRC, searched for real.
        innertube.searchSongs.mockResolvedValueOnce([cand(V2, { durationSec: 260 })]);
        expect(await resolve(db, track('far', { isrc: 'X4', durationSec: 260 }))).toMatchObject({ videoId: V2, method: 'ytmusic' });
        expect((await db.get(`SELECT duration_sec FROM track_matches WHERE external_id = 'far'`)).duration_sec).toBe(260);
        // The 260 s row is now the newest sibling, but it is skipped for a 200 s track.
        expect(await resolve(db, track('near2', { isrc: 'X4', durationSec: 199 }))).toMatchObject({ videoId: V1, method: 'isrc' });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);
    });

    it('a manual sibling without a stored duration is still reusable', async () => {
        await setOverride(db, { source: 'spotify', externalId: 'man2', videoId: MANUAL, userId: 1, isrc: 'X5' });
        expect(await resolve(db, track('e', { isrc: 'X5', durationSec: 123 }))).toMatchObject({ videoId: MANUAL, method: 'isrc' });
        expect(innertube.searchSongs).not.toHaveBeenCalled();
    });

    it('force skips the ISRC shortcut and searches', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('src', { isrc: 'X6' }));
        innertube.searchSongs.mockResolvedValueOnce([cand(V2)]);
        expect(await resolve(db, track('forced', { isrc: 'X6' }), { force: true })).toMatchObject({ videoId: V2, method: 'ytmusic' });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);
    });
});

// --- Overrides -----------------------------------------------------------------

describe('overrides', () => {
    it('setOverride upserts a manual match that a later resolve returns without searching', async () => {
        await setOverride(db, { source: 'spotify', externalId: 'o1', videoId: MANUAL, userId: 1 });
        expect(await getMatch(db, 'spotify', 'o1')).toMatchObject({ status: 'matched', videoId: MANUAL, method: 'manual', score: null, manual: true });
        expect(await resolve(db, track('o1'))).toEqual({ status: 'matched', videoId: MANUAL, score: null, method: 'manual', candidates: [], fromCache: true });
        expect(innertube.searchSongs).not.toHaveBeenCalled();
    });

    it('setOverride replaces an automatic match and keeps the recorded candidates', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('o2'));
        await setOverride(db, { source: 'spotify', externalId: 'o2', videoId: MANUAL, userId: 1 });
        const row = await getMatch(db, 'spotify', 'o2');
        expect(row).toMatchObject({ videoId: MANUAL, method: 'manual', manual: true });
        expect(row.candidates).toHaveLength(1);
    });

    it('rejects a videoId that is not an 11-character YouTube id', async () => {
        await expect(setOverride(db, { source: 'spotify', externalId: 'o3', videoId: 'short', userId: 1 })).rejects.toMatchObject({ code: 'MATCH_BAD_REQUEST' });
        await expect(setOverride(db, { source: 'spotify', externalId: 'o3', videoId: 'has space!!', userId: 1 })).rejects.toThrow();
        expect(await getMatch(db, 'spotify', 'o3')).toBeNull();
    });

    it('an override set while an automatic resolve is in flight wins', async () => {
        const search = deferred();
        innertube.searchSongs.mockReturnValueOnce(search.promise);
        const pending = resolve(db, track('race'));
        await until(() => innertube.searchSongs.mock.calls.length === 1);

        await setOverride(db, { source: 'spotify', externalId: 'race', videoId: MANUAL, userId: 1 });
        search.resolve([cand(V1)]);

        expect(await pending).toMatchObject({ status: 'matched', videoId: MANUAL, method: 'manual', fromCache: true });
        expect(await getMatch(db, 'spotify', 'race')).toMatchObject({ videoId: MANUAL, manual: true });
    });

    it('force re-resolves a cached match and even an override, clearing override_by', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('f'));
        innertube.searchSongs.mockResolvedValueOnce([cand(V2)]);
        expect(await resolve(db, track('f'), { force: true })).toMatchObject({ status: 'matched', videoId: V2, fromCache: false });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);

        await setOverride(db, { source: 'spotify', externalId: 'f', videoId: MANUAL, userId: 1 });
        innertube.searchSongs.mockResolvedValueOnce([cand(V3)]);
        expect(await resolve(db, track('f'), { force: true })).toMatchObject({ videoId: V3, method: 'ytmusic' });
        expect(await getMatch(db, 'spotify', 'f')).toMatchObject({ videoId: V3, manual: false });
        expect((await db.get(`SELECT override_by FROM track_matches WHERE external_id = 'f'`)).override_by).toBeNull();
    });

    it('a manual row without a user id is still final and never overwritten', async () => {
        await markUnavailable(db, { source: 'spotify', externalId: 'anon' });
        process.env.MATCH_NOT_FOUND_TTL_MS = '0';
        expect(await resolve(db, track('anon'))).toMatchObject({ status: 'not_found', method: 'manual', fromCache: true });
        expect(await getMatch(db, 'spotify', 'anon')).toMatchObject({ manual: true });
        expect(innertube.searchSongs).not.toHaveBeenCalled();

        // Set while an automatic resolve is in flight: persist() leaves it alone.
        const search = deferred();
        innertube.searchSongs.mockReturnValueOnce(search.promise);
        const pending = resolve(db, track('anon-race'));
        await until(() => innertube.searchSongs.mock.calls.length === 1);
        await setOverride(db, { source: 'spotify', externalId: 'anon-race', videoId: MANUAL });
        search.resolve([cand(V1)]);
        expect(await pending).toMatchObject({ videoId: MANUAL, method: 'manual', fromCache: true });
    });

    it('markUnavailable is a manual not_found that resolve never retries', async () => {
        await markUnavailable(db, { source: 'spotify', externalId: 'u', userId: 1 });
        expect(await getMatch(db, 'spotify', 'u')).toMatchObject({ status: 'not_found', method: 'manual', manual: true, videoId: null });
        process.env.MATCH_NOT_FOUND_TTL_MS = '0';
        expect(await resolve(db, track('u'))).toMatchObject({ status: 'not_found', method: 'manual', fromCache: true });
        expect(innertube.searchSongs).not.toHaveBeenCalled();
    });
});

// --- forget --------------------------------------------------------------------

describe('forget', () => {
    it('deletes the row, drops the in-flight entry and makes the next resolve search for real', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        await resolve(db, track('origin', { isrc: 'Y1' }));
        expect(await resolve(db, track('wrong', { isrc: 'Y1' }))).toMatchObject({ videoId: V1, method: 'isrc' });

        await forget(db, 'spotify', 'wrong');
        expect(await getMatch(db, 'spotify', 'wrong')).toBeNull();
        expect(_internals.inFlight.has('spotify:wrong')).toBe(false);

        // Without the skip, the sibling's answer would simply be copied back.
        innertube.searchSongs.mockResolvedValueOnce([cand(V2)]);
        expect(await resolve(db, track('wrong', { isrc: 'Y1' }))).toMatchObject({ videoId: V2, method: 'ytmusic', fromCache: false });
        // The skip is consumed: a later resolve of the same key may copy again.
        expect(_internals.forgotten.has('spotify:wrong')).toBe(false);
    });

    it('is a no-op for a track that was never matched', async () => {
        await forget(db, 'spotify', 'never');
        expect(await getMatch(db, 'spotify', 'never')).toBeNull();
    });
});

// --- Reports -------------------------------------------------------------------

describe('report', () => {
    it('stores the report and applies a suggested video as an override', async () => {
        await report(db, { source: 'spotify', externalId: 'r1', userId: 1, reason: 'wrong_match', videoId: MANUAL, note: 'live version' });
        const rows = await db.all(`SELECT * FROM match_reports`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: 1, source_id: 2, external_id: 'r1', reason: 'wrong_match', video_id: MANUAL, note: 'live version' });
        expect(await getMatch(db, 'spotify', 'r1')).toMatchObject({ status: 'matched', videoId: MANUAL, method: 'manual', manual: true });
    });

    it('reason unavailable marks the track unavailable', async () => {
        await report(db, { source: 'spotify', externalId: 'r2', userId: 1, reason: 'unavailable' });
        expect(await getMatch(db, 'spotify', 'r2')).toMatchObject({ status: 'not_found', method: 'manual', manual: true });
    });

    it('a plain report changes no match row', async () => {
        await report(db, { source: 'spotify', externalId: 'r3', userId: null, reason: 'other', note: 'hm' });
        expect(await getMatch(db, 'spotify', 'r3')).toBeNull();
        expect(await db.get(`SELECT count(*) AS n FROM match_reports`)).toEqual({ n: 1 });
    });

    it('rejects a bad reason or video id before writing anything', async () => {
        await expect(report(db, { source: 'spotify', externalId: 'r4', userId: 1, reason: 'meh' })).rejects.toMatchObject({ code: 'MATCH_BAD_REQUEST' });
        await expect(report(db, { source: 'spotify', externalId: 'r4', userId: 1, reason: 'wrong_match', videoId: 'nope' })).rejects.toMatchObject({ code: 'MATCH_BAD_REQUEST' });
        expect(await db.get(`SELECT count(*) AS n FROM match_reports`)).toEqual({ n: 0 });
    });
});

// --- De-duplication and queues -------------------------------------------------

describe('in-flight de-duplication', () => {
    it('two concurrent resolves of the same track share one search', async () => {
        const search = deferred();
        innertube.searchSongs.mockReturnValueOnce(search.promise);
        const a = resolve(db, track('dup'));
        const b = resolve(db, track('dup'));
        expect(_internals.inFlight.size).toBe(1);
        await until(() => innertube.searchSongs.mock.calls.length === 1);
        search.resolve([cand(V1)]);
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra).toEqual(rb);
        expect(ra).toMatchObject({ status: 'matched', videoId: V1, fromCache: false });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(1);
        expect(_internals.inFlight.size).toBe(0);
    });

    it('clears the in-flight entry when the resolution fails', async () => {
        jest.spyOn(db, 'run').mockRejectedValueOnce(new Error('disk full'));
        await expect(resolve(db, track('fail'))).rejects.toThrow('disk full');
        expect(_internals.inFlight.size).toBe(0);
    });

    it('different tracks do not share a promise', async () => {
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]).mockResolvedValueOnce([cand(V2)]);
        const [a, b] = await Promise.all([resolve(db, track('x')), resolve(db, track('y'))]);
        expect([a.videoId, b.videoId].sort()).toEqual([V1, V2]);
    });
});

describe('queues', () => {
    // A search that records how many are running at once.
    function gatedSearch(counter, result) {
        return async () => {
            counter.now += 1;
            counter.max = Math.max(counter.max, counter.now);
            await sleep(15);
            counter.now -= 1;
            return result;
        };
    }

    it('never runs more InnerTube searches than MATCH_CONCURRENCY at once', async () => {
        process.env.MATCH_CONCURRENCY = '2';
        const counter = { now: 0, max: 0 };
        innertube.searchSongs.mockImplementation(gatedSearch(counter, [cand(V1)]));
        const tracks = [1, 2, 3, 4, 5, 6].map((n) => track(`c${n}`));
        const results = await resolveMany(db, tracks);
        expect(results.size).toBe(6);
        expect([...results.values()].every((r) => r.status === 'matched')).toBe(true);
        expect(innertube.searchSongs).toHaveBeenCalledTimes(6);
        expect(counter.max).toBe(2);
        expect(_internals.queue.peak).toBe(2);
    });

    it('defaults to four slots and reads the env var at call time', async () => {
        const counter = { now: 0, max: 0 };
        innertube.searchSongs.mockImplementation(gatedSearch(counter, [cand(V1)]));
        await resolveMany(db, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => track(`d${n}`)));
        expect(counter.max).toBe(4);

        _internals.resetForTests();
        process.env.MATCH_CONCURRENCY = '1';
        const serial = { now: 0, max: 0 };
        innertube.searchSongs.mockImplementation(gatedSearch(serial, [cand(V1)]));
        await resolveMany(db, [1, 2, 3].map((n) => track(`e${n}`)));
        expect(serial.max).toBe(1);
    });

    it('runs yt-dlp searches one at a time', async () => {
        innertube.searchSongs.mockRejectedValue(sourceError('UNAVAILABLE'));
        const counter = { now: 0, max: 0 };
        ytsearch.searchVideos.mockImplementation(gatedSearch(counter, [ytCand(V1)]));
        const results = await resolveMany(db, [1, 2, 3].map((n) => track(`y${n}`)));
        expect([...results.values()].every((r) => r.status === 'matched' && r.method === 'ytsearch')).toBe(true);
        expect(ytsearch.searchVideos).toHaveBeenCalledTimes(3);
        expect(counter.max).toBe(1);
        expect(_internals.ytsearchQueue.peak).toBe(1);
    });

    it('refuses new tasks once the backlog is full, as UNAVAILABLE, instead of queueing forever', async () => {
        const queue = _internals.createQueue(() => 1, { maxWaiting: 2 });
        const gate = deferred();
        const running = queue.run(() => gate.promise);
        const w1 = queue.run(async () => 'w1');
        const w2 = queue.run(async () => 'w2');
        expect(queue.waiting).toBe(2);
        await expect(queue.run(async () => 'w3')).rejects.toMatchObject({ name: 'MatchSourceError', code: 'UNAVAILABLE' });
        gate.resolve('r');
        expect(await Promise.all([running, w1, w2])).toEqual(['r', 'w1', 'w2']);
        expect(_internals.queue.maxWaiting).toBe(500);
        expect(_internals.ytsearchQueue.maxWaiting).toBe(50);
    });

    it('a full backlog persists the track as error rather than hanging the request', async () => {
        process.env.MATCH_CONCURRENCY = '1';
        const gate = deferred();
        innertube.searchSongs.mockReturnValue(gate.promise);
        const blockers = [_internals.queue.run(() => gate.promise)];
        for (let i = 0; i < 500; i++) blockers.push(_internals.queue.run(() => gate.promise));
        process.env.MATCH_YTDLP_FALLBACK = 'off';
        expect(await resolve(db, track('full'))).toMatchObject({ status: 'error' });
        expect((await getMatch(db, 'spotify', 'full')).status).toBe('error');
        gate.resolve([]);
        await Promise.all(blockers);
    });

    it('reset rejects the dropped waiters and leaves the running count to the running tasks', async () => {
        const queue = _internals.createQueue(() => 1);
        const gate = deferred();
        const running = queue.run(() => gate.promise);
        const waiting = queue.run(async () => 'never');
        expect(queue.active).toBe(1);
        queue.reset();
        await expect(waiting).rejects.toThrow('queue reset');
        expect(queue.active).toBe(1);
        gate.resolve('done');
        expect(await running).toBe('done');
        await flushIo(); // the slot is released in a finally() after the result is handed out
        expect(queue.active).toBe(0);
        // A new task after the reset runs normally.
        expect(await queue.run(async () => 'next')).toBe('next');
        await flushIo();
        expect(queue.active).toBe(0);
    });

    it('serves the queue first-in first-out and clears slots after a failure', async () => {
        process.env.MATCH_CONCURRENCY = '1';
        const order = [];
        const task = (name) => async () => { order.push(name); await sleep(2); if (name === 'b') throw new Error('b failed'); return name; };
        const runs = ['a', 'b', 'c', 'd'].map((name) => _internals.queue.run(task(name)));
        expect(_internals.queue.active).toBe(1);
        expect(_internals.queue.waiting).toBe(3);
        const settled = await Promise.allSettled(runs);
        expect(order).toEqual(['a', 'b', 'c', 'd']);
        expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
        expect(_internals.queue.active).toBe(0);
        expect(_internals.queue.peak).toBe(1);
    });
});

// --- resolveMany ---------------------------------------------------------------

describe('resolveMany', () => {
    it('returns a Map keyed by source:id, de-duplicating repeated tracks', async () => {
        innertube.searchSongs.mockResolvedValue([cand(V1)]);
        const results = await resolveMany(db, [track('m1'), track('m2'), track('m1'), null, { source: 'spotify' }]);
        expect([...results.keys()]).toEqual(['spotify:m1', 'spotify:m2']);
        expect(results.get('spotify:m1')).toMatchObject({ status: 'matched', videoId: V1 });
        expect(innertube.searchSongs).toHaveBeenCalledTimes(2);
    });

    it('reports pending when the budget elapses and finishes the work in the background', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        const slow = deferred();
        // Dispatch by query, not by call order: the two tracks reach the search
        // in whichever order their SQLite cache reads complete, so a
        // mockResolvedValueOnce chain would sometimes hand `slow` the instant
        // answer and leave `fast` on the never-resolving promise.
        innertube.searchSongs.mockImplementation((q) => (q.includes('slow') ? slow.promise : Promise.resolve([cand(V1)])));
        try {
            const pending = resolveMany(db, [track('fast'), track('slow')], { timeoutMs: BUDGET_MS });
            // Let the fast track's real SQLite round-trips finish before the
            // (fake) clock reaches the budget, so the outcome is deterministic.
            await _internals.inFlight.get('spotify:fast');
            await flushIo();
            await jest.advanceTimersByTimeAsync(BUDGET_MS);
            const results = await pending;
            expect(results.get('spotify:fast')).toMatchObject({ status: 'matched', videoId: V1 });
            expect(results.get('spotify:slow')).toEqual({ status: 'pending' });
            expect(await getMatch(db, 'spotify', 'slow')).toBeNull();
            expect(_internals.inFlight.has('spotify:slow')).toBe(true);
        } finally {
            // Always release the search so afterEach's settleInFlight() cannot hang.
            slow.resolve([cand(V2)]);
        }
        await settleInFlight();
        expect(await getMatch(db, 'spotify', 'slow')).toMatchObject({ status: 'matched', videoId: V2 });
        // A later request joins the finished work from the cache.
        expect(await resolveMany(db, [track('slow')])).toEqual(new Map([['spotify:slow', expect.objectContaining({ status: 'matched', videoId: V2, fromCache: true })]]));
    });

    it('takes the default budget from MATCH_REQUEST_BUDGET_MS at call time', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        process.env.MATCH_REQUEST_BUDGET_MS = '30';
        const slow = deferred();
        innertube.searchSongs.mockReturnValueOnce(slow.promise);
        const pending = resolveMany(db, [track('budget')]);
        await jest.advanceTimersByTimeAsync(30);
        expect((await pending).get('spotify:budget')).toEqual({ status: 'pending' });
        slow.resolve([]);
    });

    it.each([
        ['an explicit timeout above 2^31-1 ms', { timeoutMs: 2 ** 31 }, null],
        ['Infinity', { timeoutMs: Infinity }, null],
        ['MATCH_REQUEST_BUDGET_MS above 2^31-1', {}, '9999999999']
    ])('%s means no budget, not a 1 ms one', async (_label, opts, env) => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        if (env) process.env.MATCH_REQUEST_BUDGET_MS = env;
        const slow = deferred();
        innertube.searchSongs.mockReturnValueOnce(slow.promise);
        let settled = false;
        const pending = resolveMany(db, [track('nobudget')], opts).then((r) => { settled = true; return r; });
        await jest.advanceTimersByTimeAsync(10_000);
        await flushIo();
        expect(settled).toBe(false);
        slow.resolve([cand(V1)]);
        expect((await pending).get('spotify:nobudget')).toMatchObject({ status: 'matched', videoId: V1 });
    });

    it('turns an unexpected failure for one track into status error without sinking the batch', async () => {
        innertube.searchSongs.mockResolvedValue([cand(V1)]);
        const run = db.run.bind(db);
        jest.spyOn(db, 'run').mockImplementation((sql, params) => (Array.isArray(params) && params[1] === 'bad' ? Promise.reject(new Error('disk full')) : run(sql, params)));
        const results = await resolveMany(db, [track('good'), track('bad')]);
        expect(results.get('spotify:good')).toMatchObject({ status: 'matched' });
        expect(results.get('spotify:bad')).toMatchObject({ status: 'error', videoId: null });
    });

    it('returns an empty Map for no tracks', async () => {
        expect(await resolveMany(db, [])).toEqual(new Map());
        expect(await resolveMany(db, undefined)).toEqual(new Map());
    });
});

// --- filterPlayable ------------------------------------------------------------

describe('filterPlayable', () => {
    const yt = { source: 'youtube', id: 'yt1', title: 'Video', artist: 'Someone' };
    const sc = { source: 'soundcloud', id: '42', title: 'Mix', artist: 'DJ' };

    it('does zero DB work and keeps the array when no item belongs to a match source', async () => {
        const spies = ['get', 'all', 'run', 'exec'].map((m) => jest.spyOn(db, m));
        const tracks = [yt, sc];
        const { items, summary } = await filterPlayable(db, tracks);
        expect(items).toBe(tracks);
        expect(items[0]).toBe(yt);
        expect(summary).toEqual({ total: 0, matched: 0, hidden: 0, pending: 0, errors: 0 });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(innertube.searchSongs).not.toHaveBeenCalled();
    });

    it('keeps order, attaches youtubeId and match, hides unmatched and passes other sources through', async () => {
        await setOverride(db, { source: 'spotify', externalId: 's1', videoId: MANUAL, userId: 1 });
        await resolve(db, track('s2')); // not_found, cached
        innertube.searchSongs.mockClear();
        innertube.searchSongs.mockImplementation(async (q) => (q.includes('Song s3') ? [cand(V1, { score: 93 })] : []));

        const s1 = track('s1');
        const s2 = track('s2');
        const s3 = track('s3');
        const s4 = track('s4');
        const { items, summary } = await filterPlayable(db, [yt, s1, s2, sc, s3, s4]);

        expect(items.map((t) => t.id)).toEqual(['yt1', 's1', '42', 's3']);
        expect(items[0]).toBe(yt);
        expect(items[2]).toBe(sc);
        expect(items[1]).toEqual({ ...s1, youtubeId: MANUAL, match: { status: 'matched', score: null, method: 'manual' } });
        expect(items[3]).toEqual({ ...s3, youtubeId: V1, match: { status: 'matched', score: 93, method: 'ytmusic' } });
        expect(summary).toEqual({ total: 4, matched: 2, hidden: 2, pending: 0, errors: 0 });
        // The two uncached tracks were searched (s4, unmatched, also title-first); the cached ones were not.
        expect(innertube.searchSongs.mock.calls.map(([q]) => q).sort()).toEqual(['Artist Song s3', 'Artist Song s4', 'song s4 Artist']);
    });

    it('reads cached rows with one query per source instead of one per track', async () => {
        listProviders.mockReturnValue([{ name: 'tidal', capabilities: { playback: 'match' } }]);
        await db.run(`INSERT INTO sources (id, name) VALUES (9, 'tidal')`);
        innertube.searchSongs.mockResolvedValue([cand(V1)]);
        const tracks = [track('p1'), track('p2'), track('p3'), { ...track('p4'), source: 'tidal' }, { ...track('p5'), source: 'tidal' }];
        await resolveMany(db, tracks); // warm every row and the source id cache

        const allSpy = jest.spyOn(db, 'all');
        const getSpy = jest.spyOn(db, 'get');
        innertube.searchSongs.mockClear();
        const { items, summary } = await filterPlayable(db, tracks);
        expect(items).toHaveLength(5);
        expect(summary).toMatchObject({ total: 5, matched: 5 });
        expect(allSpy).toHaveBeenCalledTimes(2);
        expect(getSpy).not.toHaveBeenCalled();
        expect(innertube.searchSongs).not.toHaveBeenCalled();
    });

    it('re-resolves stale not_found and error rows found by the batch read', async () => {
        await resolve(db, track('stale'));
        await db.run(`UPDATE track_matches SET checked_at = 1 WHERE external_id = 'stale'`);
        innertube.searchSongs.mockResolvedValue([cand(V2)]);
        const { items, summary } = await filterPlayable(db, [track('stale')]);
        expect(items).toEqual([expect.objectContaining({ id: 'stale', youtubeId: V2 })]);
        expect(summary).toEqual({ total: 1, matched: 1, hidden: 0, pending: 0, errors: 0 });
    });

    it('counts pending and errors among the hidden tracks and honours opts.timeoutMs', async () => {
        const slow = deferred();
        innertube.searchSongs.mockImplementation((q) => {
            if (q.includes('slow')) return slow.promise;
            if (q.includes('broken')) return Promise.reject(sourceError('UPSTREAM'));
            return Promise.resolve([cand(V1)]);
        });
        process.env.MATCH_YTDLP_FALLBACK = 'off';
        try {
            const { items, summary } = await filterPlayable(db, [track('ok'), track('slow'), track('broken')], { timeoutMs: BUDGET_MS });
            expect(items.map((t) => t.id)).toEqual(['ok']);
            expect(summary).toEqual({ total: 3, matched: 1, hidden: 2, pending: 1, errors: 1 });
        } finally {
            slow.resolve([]);
        }
    });

    it('hides the tracks of a match-mode source without a sources row and counts them as errors', async () => {
        listProviders.mockReturnValue([{ name: 'ghost', capabilities: { playback: 'match' } }]);
        innertube.searchSongs.mockResolvedValue([cand(V1)]);
        const ghost = { ...track('g1'), source: 'ghost' };
        const { items, summary } = await filterPlayable(db, [yt, ghost, track('ok1'), { ...track('g2'), source: 'ghost' }]);
        expect(items.map((t) => t.id)).toEqual(['yt1', 'ok1']);
        expect(summary).toEqual({ total: 3, matched: 1, hidden: 2, pending: 0, errors: 2 });
        // Logged once per source, not once per page.
        await filterPlayable(db, [ghost]);
        expect(warnSpy.mock.calls.filter(([m]) => /ghost/.test(m))).toHaveLength(1);
    });

    it('hides a match-mode track that has no id', async () => {
        const { items, summary } = await filterPlayable(db, [{ source: 'spotify', title: 'No id' }, yt]);
        expect(items).toEqual([yt]);
        expect(summary).toEqual({ total: 1, matched: 0, hidden: 1, pending: 0, errors: 0 });
        expect(innertube.searchSongs).not.toHaveBeenCalled();
    });

    it('treats a non-array input as an empty list', async () => {
        expect(await filterPlayable(db, undefined)).toEqual({ items: [], summary: { total: 0, matched: 0, hidden: 0, pending: 0, errors: 0 } });
    });
});

// --- yt-dlp fallback -----------------------------------------------------------

describe('yt-dlp fallback', () => {
    it('runs when InnerTube fails and its match is recorded with method ytsearch', async () => {
        innertube.searchSongs.mockRejectedValueOnce(sourceError('UNAVAILABLE'));
        ytsearch.searchVideos.mockResolvedValueOnce([ytCand(V1, { score: 75 })]);
        const t = track('fb', { artist: 'Daft Punk', title: 'Get Lucky' });
        const result = await resolve(db, t);
        expect(ytsearch.searchVideos).toHaveBeenCalledWith('Daft Punk', 'get lucky');
        expect(result).toMatchObject({ status: 'matched', videoId: V1, score: 75, method: 'ytsearch', fromCache: false });
        expect(await getMatch(db, 'spotify', 'fb')).toMatchObject({ method: 'ytsearch' });
    });

    it('searches yt-dlp for the bare title, not the full Spotify title', async () => {
        innertube.searchSongs.mockRejectedValueOnce(sourceError('UNAVAILABLE'));
        await resolve(db, track('bare', { artist: 'Daft Punk', title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)' }));
        expect(ytsearch.searchVideos).toHaveBeenCalledWith('Daft Punk', 'get lucky');
    });

    it('does not run merely because InnerTube found no acceptable candidate', async () => {
        innertube.searchSongs.mockResolvedValue([cand(V1, { ok: false })]);
        const result = await resolve(db, track('nocand'));
        expect(result.status).toBe('not_found');
        expect(ytsearch.searchVideos).not.toHaveBeenCalled();
    });

    it('MATCH_YTDLP_RECALL=true also runs it on no acceptable candidate', async () => {
        process.env.MATCH_YTDLP_RECALL = 'true';
        innertube.searchSongs.mockResolvedValue([cand(V1, { ok: false })]);
        ytsearch.searchVideos.mockResolvedValueOnce([ytCand(V2)]);
        const result = await resolve(db, track('recall'));
        expect(ytsearch.searchVideos).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'matched', videoId: V2, method: 'ytsearch' });
        // Both the rejected InnerTube candidate and the chosen yt-dlp one are kept.
        expect(result.candidates.map((c) => c.videoId)).toEqual([V2, V1]);
    });

    it('recall with nothing from yt-dlp either is a plain not_found', async () => {
        process.env.MATCH_YTDLP_RECALL = '1';
        expect(await resolve(db, track('recall-nf'))).toMatchObject({ status: 'not_found' });
        expect(ytsearch.searchVideos).toHaveBeenCalledTimes(1);
    });

    it('MATCH_YTDLP_FALLBACK=off disables it even on failure', async () => {
        process.env.MATCH_YTDLP_FALLBACK = 'off';
        innertube.searchSongs.mockRejectedValueOnce(sourceError('UNAVAILABLE'));
        expect(await resolve(db, track('off'))).toMatchObject({ status: 'error' });
        expect(ytsearch.searchVideos).not.toHaveBeenCalled();
    });

    it('a fallback failure after an InnerTube failure is status error, retried after the error TTL', async () => {
        innertube.searchSongs.mockRejectedValueOnce(sourceError('UNAVAILABLE'));
        ytsearch.searchVideos.mockRejectedValueOnce(Object.assign(new Error('yt-dlp failed'), { code: 'YTDLP_FAILED' }));
        expect(await resolve(db, track('both'))).toMatchObject({ status: 'error', videoId: null });
        process.env.MATCH_ERROR_TTL_MS = '0';
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        expect(await resolve(db, track('both'))).toMatchObject({ status: 'matched', videoId: V1 });
    });

    it('prefers an InnerTube candidate over a yt-dlp one when both pass', async () => {
        // songs failed, videos (second InnerTube call) is never reached, but the
        // fallback result is pooled with whatever InnerTube already returned.
        innertube.searchSongs.mockResolvedValueOnce([cand(V1, { ok: false })]);
        innertube.searchVideos.mockRejectedValueOnce(sourceError('UPSTREAM'));
        ytsearch.searchVideos.mockResolvedValueOnce([ytCand(V2, { score: 70 }), ytCand(V1, { score: 99 })]);
        const result = await resolve(db, track('pool', { title: 'Song (Live)' }));
        // V1 was first seen from InnerTube (rejected) and is not re-admitted via yt-dlp.
        expect(result).toMatchObject({ status: 'matched', videoId: V2, method: 'ytsearch' });
    });
});

// --- Rate-limit back-off -------------------------------------------------------

describe('InnerTube rate-limit back-off', () => {
    it('stops asking InnerTube and skips yt-dlp for Retry-After, then resumes', async () => {
        const now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
        try {
            innertube.searchSongs.mockRejectedValueOnce(sourceError('RATE_LIMITED', { retryAfterMs: 30_000 }));
            expect(await resolve(db, track('rl1'))).toMatchObject({ status: 'error' });
            expect(ytsearch.searchVideos).not.toHaveBeenCalled();
            expect(_internals.blockedUntil()).toBe(now + 30_000);

            // While blocked: no InnerTube call, no yt-dlp, persisted as error.
            expect(await resolve(db, track('rl2'))).toMatchObject({ status: 'error', videoId: null });
            expect(innertube.searchSongs).toHaveBeenCalledTimes(1);
            expect(ytsearch.searchVideos).not.toHaveBeenCalled();
            expect((await getMatch(db, 'spotify', 'rl2')).status).toBe('error');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RATE_LIMITED'));

            // Past the window the next track is searched again.
            clock.mockReturnValue(now + 30_001);
            innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
            expect(await resolve(db, track('rl3'))).toMatchObject({ status: 'matched', videoId: V1 });
        } finally {
            clock.mockRestore();
        }
    });

    it('backs off for 60 s when the answer carries no Retry-After', async () => {
        const now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
        try {
            innertube.searchSongs.mockRejectedValueOnce(sourceError('RATE_LIMITED'));
            await resolve(db, track('rl4'));
            expect(_internals.blockedUntil()).toBe(now + 60_000);
        } finally {
            clock.mockRestore();
        }
    });

    it('a blocked track is retried after MATCH_ERROR_TTL_MS like any error', async () => {
        innertube.searchSongs.mockRejectedValueOnce(sourceError('RATE_LIMITED', { retryAfterMs: 1 }));
        await resolve(db, track('rl5'));
        expect(await resolve(db, track('rl5'))).toMatchObject({ status: 'error', fromCache: true });
        process.env.MATCH_ERROR_TTL_MS = '0';
        await sleep(2);
        innertube.searchSongs.mockResolvedValueOnce([cand(V2)]);
        expect(await resolve(db, track('rl5'))).toMatchObject({ status: 'matched', videoId: V2 });
    });

    it('resetForTests clears the block', async () => {
        innertube.searchSongs.mockRejectedValueOnce(sourceError('RATE_LIMITED', { retryAfterMs: 60_000 }));
        await resolve(db, track('rl6'));
        expect(_internals.blockedUntil()).toBeGreaterThan(Date.now());
        _internals.resetForTests();
        expect(_internals.blockedUntil()).toBe(0);
        innertube.searchSongs.mockResolvedValueOnce([cand(V1)]);
        expect(await resolve(db, track('rl7'))).toMatchObject({ status: 'matched' });
    });
});
