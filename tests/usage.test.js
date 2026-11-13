// Usage meter (services/usage.js), the match decision log
// (services/matcher/journal.js) and the two owner-only routes that read them.
// Real database and real log file in a temp folder; the matcher's two network
// seams are stubbed with the recorded fixtures.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../providers', () => ({ listProviders: jest.fn(() => []), getProvider: jest.fn() }));

const KEYS = ['MATCH_LOG', 'MUSIC_DATA_DIR', 'YOUTUBE_API_DAILY_QUOTA', 'MATCH_YTDLP_FALLBACK'];
const SONGS = fs.readFileSync(path.join(__dirname, 'fixtures', 'innertube-search.json'), 'utf8');
const ALBUM_TRACK = {
    source: 'spotify',
    id: '2Foc5Q5nqNiosCNqttzHof',
    title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)',
    artist: 'Daft Punk',
    artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
    album: 'Random Access Memories',
    durationSec: 369,
    isrc: 'USQX91300108'
};
const okResponse = (text) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => text });
const authFor = (userId) => ({ Authorization: `Bearer ${jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: '1h' })}` });

let saved;
let tmp;
let db;
let usage;
let journal;
let matcher;
let innertube;
let ytsearch;

beforeEach(async () => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-usage-'));
    process.env.MUSIC_DATA_DIR = tmp;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.resetModules();
    db = await require('../config/db')(':memory:');
    usage = require('../services/usage');
    journal = require('../services/matcher/journal');
    matcher = require('../services/matcher');
    innertube = require('../services/matcher/innertube');
    ytsearch = require('../services/matcher/ytsearch');
    innertube.http.fetch = jest.fn(async () => okResponse(SONGS));
    ytsearch.runner.exec = jest.fn(async () => { throw new Error('yt-dlp must not be spawned in this test'); });
});

afterEach(async () => {
    await usage.detach();
    console.log.mockRestore();
    console.warn.mockRestore();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

describe('usage meter', () => {
    it('adds up counts, time and units, and ignores bad input', () => {
        usage.record('innertube.search', { ms: 400 });
        usage.record('innertube.search', { ms: 600 });
        usage.record('not a metric name!');
        usage.record('ytdlp.search', { ms: -5, count: 'x' });
        expect(usage.snapshot().metrics).toEqual({
            'innertube.search': { count: 2, ms: 1000, units: 0 },
            'ytdlp.search': { count: 0, ms: 0, units: 0 }
        });
    });

    it('charges Data API calls their quota cost: a search is 100 units, a list call 1', () => {
        usage.recordYouTubeApi('search.list');
        usage.recordYouTubeApi('videos.list');
        usage.recordYouTubeApi('videos.rate');
        usage.recordYouTubeApi('something.new');
        const { metrics } = usage.snapshot();
        expect(metrics['youtube_api.search_list'].units).toBe(100);
        expect(metrics['youtube_api.videos_list'].units).toBe(1);
        expect(metrics['youtube_api.videos_rate'].units).toBe(50);
        expect(metrics['youtube_api.something_new'].units).toBe(1);
    });

    it('keeps the day under Pacific time, where the quota resets', () => {
        // 06:30 UTC on 14 November is still the 13th in Los Angeles.
        expect(usage.dayOf(new Date('2026-11-14T06:30:00Z'))).toBe('2026-11-13');
        expect(usage.dayOf(new Date('2026-11-14T08:30:00Z'))).toBe('2026-11-14');
    });

    it('saves totals per day, adds to them across flushes, and reports the quota left', async () => {
        usage.attach(db);
        usage.recordYouTubeApi('search.list');
        usage.recordYouTubeApi('search.list');
        usage.recordYouTubeApi('videos.list');
        await usage.flush();
        usage.recordYouTubeApi('search.list');
        const report = await usage.report(db);

        const rows = await db.all('SELECT metric, count, units FROM usage_daily ORDER BY metric');
        expect(rows).toEqual([
            { metric: 'youtube_api.search_list', count: 3, units: 300 },
            { metric: 'youtube_api.videos_list', count: 1, units: 1 }
        ]);
        expect(report.today).toBe(usage.dayOf());
        expect(report.youtubeApi).toMatchObject({ unitsUsed: 301, dailyQuota: 10000, unitsLeft: 9699 });
        expect(report.days).toHaveLength(1);
        expect(report.days[0].metrics['youtube_api.search_list']).toEqual({ count: 3, ms: 0, units: 300 });
    });

    it('follows YOUTUBE_API_DAILY_QUOTA and never reports a negative remainder', async () => {
        process.env.YOUTUBE_API_DAILY_QUOTA = '150';
        usage.attach(db);
        usage.recordYouTubeApi('search.list');
        usage.recordYouTubeApi('search.list');
        expect((await usage.report(db)).youtubeApi).toMatchObject({ unitsUsed: 200, dailyQuota: 150, unitsLeft: 0 });
    });

    it('keeps what a failed save could not write and saves it next time', async () => {
        const broken = { run: jest.fn(async () => { throw new Error('disk full'); }), all: jest.fn(async () => []) };
        usage.attach(broken);
        usage.record('innertube.search', { ms: 10 });
        await usage.flush();
        usage.attach(db);
        await usage.flush();
        expect(await db.get(`SELECT count, ms FROM usage_daily WHERE metric = 'innertube.search'`)).toEqual({ count: 1, ms: 10 });
    });

    it('meters the Data API client: every call is counted when it is sent, even one that fails', async () => {
        const { meter } = require('../controllers/youtubeClient');
        const client = meter({
            search: { list: jest.fn(async () => ({ data: { items: [] } })) },
            videos: { list: jest.fn(async () => { throw new Error('quotaExceeded'); }), rate: jest.fn(async () => ({})) },
            playlists: { list: jest.fn(async () => ({})) }
        });
        await client.search.list({ q: 'x' });
        await expect(client.videos.list({ id: 'a' })).rejects.toThrow('quotaExceeded');
        const { metrics } = usage.snapshot();
        expect(metrics['youtube_api.search_list']).toMatchObject({ count: 1, units: 100 });
        expect(metrics['youtube_api.videos_list']).toMatchObject({ count: 1, units: 1 });
        expect(metrics['youtube_api.playlists_list']).toBeUndefined();
    });
});

describe('match engine: what a decision costs and what is logged', () => {
    it('counts one search and one match for a fresh track, and a cache hit for the next ask', async () => {
        const entries = [];
        journal.hooks.sink = (entry) => entries.push(entry);

        const first = await matcher.resolve(db, ALBUM_TRACK);
        const second = await matcher.resolve(db, ALBUM_TRACK);

        expect(first).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8', fromCache: false });
        expect(second).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8', fromCache: true });
        const { metrics } = usage.snapshot();
        expect(metrics['innertube.search'].count).toBe(1);
        expect(metrics['match.matched'].count).toBe(1);
        expect(metrics['match.cache_hit'].count).toBe(1);
        expect(usage.matchSummary(metrics)).toMatchObject({
            asked: 2, answeredFromCache: 1, searched: 1, cacheHitRate: 0.5, innertubeSearches: 1, innertubeSearchesPerSearchedTrack: 1, ytdlpSearches: 0
        });
        // Only the fresh decision is logged.
        expect(entries).toHaveLength(1);
    });

    it('logs the track, each search with its results, the verdicts and the cost', async () => {
        const entries = [];
        journal.hooks.sink = (entry) => entries.push(entry);
        await matcher.resolve(db, ALBUM_TRACK);

        const [entry] = entries;
        expect(entry).toMatchObject({
            key: 'spotify:2Foc5Q5nqNiosCNqttzHof',
            track: { title: ALBUM_TRACK.title, artist: 'Daft Punk', artists: ALBUM_TRACK.artists, album: 'Random Access Memories', durationSec: 369, isrc: 'USQX91300108' },
            status: 'matched',
            videoId: '4D7u5KF7SP8',
            method: 'ytmusic',
            cost: { innertube: 1, ytdlp: 0 }
        });
        expect(Date.parse(entry.ts)).not.toBeNaN();
        expect(entry.steps).toHaveLength(1);
        expect(entry.steps[0]).toMatchObject({ kind: 'songs', q: 'Daft Punk Get Lucky (feat. Pharrell Williams & Nile Rodgers)' });
        // Every candidate the search returned, as the source gave it.
        const picked = entry.steps[0].results.find((c) => c.videoId === '4D7u5KF7SP8');
        expect(picked).toMatchObject({ title: expect.stringContaining('Get Lucky'), durationSec: 370, videoType: 'atv' });
        expect(picked).not.toHaveProperty('score');
        // The verdicts say why the radio edit lost.
        expect(entry.verdicts[0]).toMatchObject({ videoId: '4D7u5KF7SP8', ok: true });
        const radio = entry.verdicts.find((v) => v.videoId === 'Rgrt_8mXrK8');
        expect(radio).toMatchObject({ ok: false });
        expect(radio.reasons).toEqual(expect.arrayContaining(['title', 'duration']));
    });

    it('an answer copied by ISRC costs no search and says so', async () => {
        const entries = [];
        journal.hooks.sink = (entry) => entries.push(entry);
        await matcher.resolve(db, ALBUM_TRACK);
        const sibling = await matcher.resolve(db, { ...ALBUM_TRACK, id: 'another-release-of-it' });

        expect(sibling).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8', method: 'isrc' });
        expect(innertube.http.fetch).toHaveBeenCalledTimes(1);
        expect(entries[1]).toMatchObject({ method: 'isrc', cost: { innertube: 0, ytdlp: 0 }, steps: [] });
        expect(usage.snapshot().metrics['match.isrc_reuse'].count).toBe(1);
    });

    it('a rate limit is counted, logged as an error, and the refused follow-up costs nothing', async () => {
        const entries = [];
        journal.hooks.sink = (entry) => entries.push(entry);
        innertube.http.fetch = jest.fn(async () => ({ status: 429, ok: false, headers: { get: () => '30' }, text: async () => '' }));

        const first = await matcher.resolve(db, ALBUM_TRACK);
        const second = await matcher.resolve(db, { ...ALBUM_TRACK, id: 'second-track', isrc: null });

        expect(first.status).toBe('error');
        expect(second.status).toBe('error');
        expect(innertube.http.fetch).toHaveBeenCalledTimes(1);
        const { metrics } = usage.snapshot();
        expect(metrics['innertube.search'].count).toBe(1);
        expect(metrics['innertube.rate_limited'].count).toBe(1);
        expect(metrics['match.error'].count).toBe(2);
        expect(ytsearch.runner.exec).not.toHaveBeenCalled();
        expect(entries[0]).toMatchObject({ status: 'error', cost: { innertube: 1, ytdlp: 0 }, steps: [{ kind: 'songs', error: 'RATE_LIMITED' }] });
        // The second track was refused by the back-off before anything was sent.
        expect(entries[1]).toMatchObject({ status: 'error', cost: { innertube: 0, ytdlp: 0 } });
    });
});

describe('decision log file', () => {
    it('is off under the test runner unless asked for, and MATCH_LOG=off wins', () => {
        expect(journal.enabled()).toBe(false);
        process.env.MATCH_LOG = 'on';
        expect(journal.enabled()).toBe(true);
        process.env.MATCH_LOG = 'off';
        expect(journal.enabled()).toBe(false);
    });

    it('writes one JSON line per decision into the data folder and reads them back', async () => {
        process.env.MATCH_LOG = 'on';
        await matcher.resolve(db, ALBUM_TRACK);
        await matcher.resolve(db, { ...ALBUM_TRACK, id: 'nothing-like-it', title: 'Song That Does Not Exist', artist: 'Nobody', artists: undefined, isrc: null });

        const file = path.join(tmp, 'logs', 'matches.jsonl');
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0])).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8' });
        const recent = journal.readRecent(10);
        expect(recent.map((e) => e.status)).toEqual(['matched', 'not_found']);
        expect(journal.readRecent(1).map((e) => e.status)).toEqual(['not_found']);
        // No absolute path of this computer ends up in a line.
        expect(lines.join('\n')).not.toContain(tmp);
    });

    it('a log that cannot be written never fails the match', async () => {
        process.env.MATCH_LOG = 'on';
        fs.writeFileSync(path.join(tmp, 'logs'), 'a file where the folder should be');
        const result = await matcher.resolve(db, ALBUM_TRACK);
        expect(result).toMatchObject({ status: 'matched', videoId: '4D7u5KF7SP8' });
    });
});

describe('GET /api/system/usage and /api/system/matches', () => {
    let app;

    beforeEach(async () => {
        app = require('../app');
        app.locals.db = db;
        await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'first', 'x'), (2, 'second', 'x')`);
    });

    it('are for the owner only', async () => {
        for (const route of ['/api/system/usage', '/api/system/matches']) {
            expect((await request(app).get(route)).statusCode).toBe(401);
            expect((await request(app).get(route).set(authFor(2))).statusCode).toBe(403);
            expect((await request(app).get(route).set(authFor(1))).statusCode).toBe(200);
        }
    });

    it('report the day, the quota position, the matching summary and the latest decisions', async () => {
        process.env.MATCH_LOG = 'on';
        usage.recordYouTubeApi('search.list');
        await matcher.resolve(db, ALBUM_TRACK);
        await matcher.resolve(db, ALBUM_TRACK);

        const report = await request(app).get('/api/system/usage?days=3').set(authFor(1));
        expect(report.body.youtubeApi).toMatchObject({ unitsUsed: 100, dailyQuota: 10000, unitsLeft: 9900 });
        expect(report.body.matching).toMatchObject({ asked: 2, answeredFromCache: 1, searched: 1, innertubeSearches: 1 });
        expect(report.body.days[0].metrics['match.matched'].count).toBe(1);
        expect(report.headers['cache-control']).toBe('no-store');

        const matches = await request(app).get('/api/system/matches?limit=5').set(authFor(1));
        expect(matches.body).toMatchObject({ file: 'logs/matches.jsonl', enabled: true });
        expect(matches.body.entries).toHaveLength(1);
        expect(matches.body.entries[0]).toMatchObject({ key: 'spotify:2Foc5Q5nqNiosCNqttzHof', status: 'matched' });
        expect(JSON.stringify(matches.body)).not.toContain(tmp);
    });
});
