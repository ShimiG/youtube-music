// The match engine eval (evals/matcher/) as a gate: the engine must give, for
// every labelled case and every generated robustness check, the answer
// recorded in evals/matcher/baseline.json. A change that makes a case worse
// fails here; so does one that makes a case better or adds a case without
// refreshing the baseline (`npm run eval -- --update`), because the committed
// numbers have to describe the committed engine.
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../evals/matcher/lib');
const { runRobustness, recordedPairs } = require('../evals/matcher/robustness');
const { caseOf, casesFromEntries, readCorrections } = require('../evals/matcher/from-journal');
const innertube = require('../services/matcher/innertube');
const ytsearch = require('../services/matcher/ytsearch');
const journal = require('../services/matcher/journal');
const initDB = require('../config/db');

const cases = lib.loadCases();
const baseline = lib.readBaseline();
let run;

beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    run = await lib.runAll(cases);
    run.robustness = await runRobustness(cases, run.results);
}, 60000);

afterAll(() => jest.restoreAllMocks());

describe('match engine eval', () => {
    it('has a baseline and a set of cases worth the name', () => {
        expect(baseline).not.toBeNull();
        expect(cases.length).toBeGreaterThanOrEqual(90);
        expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
        for (const item of cases) expect(typeof item.why).toBe('string');
    });

    it('gives the baseline answer for every labelled case', () => {
        const diff = lib.compare(run.results, baseline);
        expect(diff).toEqual({ regressions: [], improvements: [], changed: [], added: [], removed: [] });
    });

    it('gives the baseline answer for every robustness check', () => {
        const diff = lib.compareRobustness(run.robustness, baseline);
        expect(diff).toEqual({ regressions: [], improvements: [], changed: [], added: [], removed: [] });
        // Every (track, right video) pair matches before it is rewritten.
        expect(run.robustness.baseFailed).toEqual([]);
    });

    it('the committed summary is the one this run produces', () => {
        expect(run.summary).toEqual(baseline.summary);
    });

    it('never plays a wrong video outside the cases that document a known limit', () => {
        const wrong = run.results.filter((r) => r.outcome === 'wrong_match');
        for (const r of wrong) expect(r.tags).toContain('limit');
    });

    it('leaves the engine\'s seams, settings and log sink as it found them', () => {
        expect(journal.hooks.sink).toBeNull();
        expect(process.env.MATCH_YTDLP_RECALL).toBeUndefined();
        // The real functions are back: a call reaches the real network layer.
        expect(String(innertube.http.fetch)).toContain('globalThis.fetch');
        expect(String(ytsearch.runner.exec)).toContain('execFile');
    });
});

describe('eval harness', () => {
    it('renders results the engine\'s own parser reads back unchanged', () => {
        const ids = { id: (label) => lib.idFor('round-trip', label) };
        const songs = [
            { label: 'a', title: 'Song (feat. Guest)', artists: ['Lead', 'Guest', 'Third'], album: 'Album', dur: 3723, plays: 1234567 },
            { label: 'b', title: 'Other', artists: ['Solo'], dur: 59, type: 'ugc' }
        ];
        const parsed = innertube.parseResults(JSON.parse(lib.renderInnertube(songs, ids, 'songs')));
        expect(parsed).toEqual([
            { videoId: ids.id('a'), title: 'Song (feat. Guest)', artists: ['Lead', 'Guest', 'Third'], album: 'Album', durationSec: 3723, plays: 1234567, videoType: 'atv', origin: 'ytmusic' },
            { videoId: ids.id('b'), title: 'Other', artists: ['Solo'], album: null, durationSec: 59, plays: 0, videoType: 'ugc', origin: 'ytmusic' }
        ]);
        const video = innertube.parseResults(JSON.parse(lib.renderInnertube([{ label: 'v', title: 'Lead - Song (Official Video)', artists: ['Lead'], dur: 200, plays: 880000000 }], ids, 'videos')));
        expect(video[0]).toMatchObject({ videoType: 'omv', durationSec: 200, plays: 880000000, album: null });

        const lines = lib.renderYtsearch([{ label: 't', title: 'Song', channel: 'Lead - Topic', dur: 200, views: 10 }, { label: 'u', title: 'Lead - Song', channel: 'Lead', dur: 201, verified: true, live: 'is_live' }], ids);
        const entries = ytsearch.parseJsonLines(lines).map(ytsearch.normalizeEntry);
        expect(entries[0]).toMatchObject({ videoId: ids.id('t'), isTopic: true, channelIsVerified: false, durationSec: 200, plays: 10 });
        expect(entries[1]).toMatchObject({ videoId: ids.id('u'), isTopic: false, channelIsVerified: true, liveStatus: 'is_live' });
    });

    it('refuses a case whose right answer names a candidate it does not have', async () => {
        const db = await initDB(':memory:');
        const item = { id: 'typo', track: { title: 'Song', artist: 'Lead', durationSec: 200 }, songs: [{ label: 'album', title: 'Song', artists: ['Lead'], dur: 200 }], accept: ['albun'] };
        await expect(lib.runCase(db, item)).rejects.toThrow('"albun" is not one of this case\'s candidates');
        await db.close();
    });

    it('tells a regression from an improvement from a stale baseline', () => {
        const row = (id, outcome, picked = null) => ({ id, outcome, picked, searches: 1, ytdlp: 0 });
        const before = { cases: { a: row('a', 'correct_match', 'x'), b: row('b', 'miss'), c: row('c', 'correct_reject'), gone: row('gone', 'miss') } };
        for (const value of Object.values(before.cases)) delete value.id;
        const diff = lib.compare([row('a', 'wrong_match', 'y'), row('b', 'correct_match', 'x'), row('c', 'correct_reject'), row('new', 'miss')], before);
        expect(diff.regressions).toEqual(['a: correct_match -> wrong_match']);
        expect(diff.improvements).toEqual(['b: miss -> correct_match']);
        expect(diff.added).toEqual(['new']);
        expect(diff.removed).toEqual(['gone']);
        expect(lib.isClean(diff)).toBe(false);
    });

    it('builds robustness pairs from every official entry in the recorded responses', () => {
        const pairs = recordedPairs();
        expect(pairs.length).toBeGreaterThanOrEqual(17);
        expect(pairs.find((p) => p.id === 'real-olf4IO9Dx4E')).toMatchObject({ track: { title: 'Maria También', artist: 'Khruangbin', durationSec: 191 } });
    });
});

describe('cases from the decision log', () => {
    const TRACK = { source: 'spotify', id: '2KPIShmFouY-track', title: 'Get Lucky', artist: 'Funk Punk', album: 'Get Lucky', durationSec: 250 };
    const SONGS = fs.readFileSync(path.join(__dirname, 'fixtures', 'innertube-search.json'), 'utf8');
    let entry;

    beforeAll(async () => {
        const matcher = require('../services/matcher');
        const db = await initDB(':memory:');
        const entries = [];
        const savedFetch = innertube.http.fetch;
        matcher._internals.resetForTests();
        journal.hooks.sink = (e) => entries.push(e);
        innertube.http.fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => SONGS });
        try {
            await matcher.resolve(db, TRACK);
        } finally {
            innertube.http.fetch = savedFetch;
            journal.hooks.sink = null;
            matcher._internals.resetForTests();
            await db.close();
        }
        // Through JSON, as it would be read back from the file.
        entry = JSON.parse(JSON.stringify(entries[0]));
    });

    it('replays a logged decision to the same answer', async () => {
        const [item] = casesFromEntries([entry], new Map(), { all: true });
        expect(item).toMatchObject({ origin: 'journal', tags: ['journal', 'unreviewed'], accept: ['2KPIShmFouY'] });
        expect(item.track).toMatchObject({ source: 'spotify', title: 'Get Lucky', artist: 'Funk Punk', durationSec: 250 });
        const db = await initDB(':memory:');
        const result = await lib.runCase(db, item);
        await db.close();
        expect(result).toMatchObject({ outcome: 'correct_match', picked: '2KPIShmFouY', searches: entry.cost.innertube });
    });

    it('labels a decision with the person\'s correction, which the replay then fails', async () => {
        const corrected = caseOf(entry, { videoId: '7FhqrDhIgQA' });
        expect(corrected.tags).toEqual(['journal', 'reported']);
        expect(corrected.accept).toEqual(['7FhqrDhIgQA']);
        const db = await initDB(':memory:');
        const result = await lib.runCase(db, corrected);
        await db.close();
        // The engine still plays what it played: now on record as a wrong match.
        expect(result).toMatchObject({ outcome: 'wrong_match', picked: '2KPIShmFouY' });
        expect(result.reasons['7FhqrDhIgQA']).toContain('artist');

        const unavailable = caseOf(entry, { unavailable: true });
        expect(unavailable.accept).toEqual([]);
    });

    it('keeps only corrected decisions unless asked for all, and the latest per track', () => {
        const older = { ...entry, ts: '2026-01-01T00:00:00.000Z', videoId: 'OLDER000000' };
        const other = { ...entry, key: 'spotify:another', ts: '2026-01-02T00:00:00.000Z' };
        const corrections = new Map([[entry.key, { videoId: '7FhqrDhIgQA' }]]);
        expect(casesFromEntries([older, entry, other], corrections).map((c) => c.track.externalId)).toEqual(['2KPIShmFouY-track']);
        expect(casesFromEntries([older, entry, other], corrections, { all: true })).toHaveLength(2);
        expect(casesFromEntries([older, entry], new Map(), { all: true })[0].accept).toEqual(['2KPIShmFouY']);
    });

    it('reads corrections from the app database without changing it', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-eval-'));
        const file = path.join(tmp, 'database.sqlite');
        const matcher = require('../services/matcher');
        const db = await initDB(file);
        await matcher.setOverride(db, { source: 'spotify', externalId: 'fixed-by-hand', videoId: '7FhqrDhIgQA' });
        await matcher.markUnavailable(db, { source: 'spotify', externalId: 'not-on-youtube' });
        await db.run(`INSERT INTO track_matches (source_id, external_id, status, video_id, method, checked_at) VALUES ((SELECT id FROM sources WHERE name = 'spotify'), 'automatic', 'matched', '4D7u5KF7SP8', 'ytmusic', 1)`);
        await db.close();
        matcher._internals.resetForTests();

        const corrections = readCorrections(file);
        expect([...corrections]).toEqual([
            ['spotify:fixed-by-hand', { videoId: '7FhqrDhIgQA' }],
            ['spotify:not-on-youtube', { unavailable: true }]
        ]);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
