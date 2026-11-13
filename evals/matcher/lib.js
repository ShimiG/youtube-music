// Replay harness for the match engine eval.
//
// A case is a track, what each search would return for it, and which of those
// results (if any) is the right recording. runCase() puts the case's results
// behind the engine's two network seams (innertube.http.fetch and
// ytsearch.runner.exec) and calls the real matcher.resolve() against a real
// in-memory SQLite, so the HTTP parsing, the query sequence, the scoring, the
// cache table and the decision log all run exactly as they ship. Nothing here
// reaches the network.
//
// The outcome is read from the engine's own decision log entry
// (services/matcher/journal.js): what the eval measures is what the log records.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const initDB = require('../../config/db');
const matcher = require('../../services/matcher');
const innertube = require('../../services/matcher/innertube');
const ytsearch = require('../../services/matcher/ytsearch');
const journal = require('../../services/matcher/journal');

const CASES_DIR = path.join(__dirname, 'cases');
const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const BASELINE_FILE = path.join(__dirname, 'baseline.json');
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TYPE_NAMES = { atv: 'MUSIC_VIDEO_TYPE_ATV', omv: 'MUSIC_VIDEO_TYPE_OMV', ugc: 'MUSIC_VIDEO_TYPE_UGC' };
// Engine settings a developer's shell could change; cleared so every run
// measures the defaults that ship (a case may set its own under "env").
const ENGINE_ENV = [
    'MATCH_DURATION_TOLERANCE_SEC', 'MATCH_CONCURRENCY', 'MATCH_REQUEST_BUDGET_MS',
    'MATCH_NOT_FOUND_TTL_MS', 'MATCH_ERROR_TTL_MS', 'MATCH_YTDLP_FALLBACK', 'MATCH_YTDLP_RECALL'
];

// --- Cases --------------------------------------------------------------------

/** Every case in evals/matcher/cases/*.json, in file then array order. */
function loadCases(dir = CASES_DIR) {
    const cases = [];
    const seen = new Set();
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
        const list = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!Array.isArray(list)) throw new Error(`${file}: a case file is a JSON array`);
        for (const item of list) {
            if (!item || typeof item.id !== 'string' || !item.id) throw new Error(`${file}: a case needs an id`);
            if (seen.has(item.id)) throw new Error(`${file}: duplicate case id "${item.id}"`);
            if (!item.track || typeof item.track.title !== 'string') throw new Error(`${item.id}: a case needs a track with a title`);
            if (!Array.isArray(item.accept)) throw new Error(`${item.id}: "accept" lists the right answers ([] when nothing should play)`);
            seen.add(item.id);
            cases.push({ ...item, file });
        }
    }
    return cases;
}

// A hand-written case names its candidates ("album", "live") instead of
// inventing video ids; the id is derived from the case and the name, so it is
// stable and can never collide with another case's.
function idFor(caseId, label) {
    return crypto.createHash('sha1').update(`${caseId}\n${label}`).digest('base64url').slice(0, 11);
}

/** label <-> videoId for one case; a label that already is a video id is kept. */
function idMap(item) {
    const toId = new Map();
    const toLabel = new Map();
    const note = (candidate) => {
        if (!candidate || typeof candidate !== 'object') return;
        const label = candidate.label || candidate.videoId || candidate.id;
        if (!label || toId.has(label)) return;
        const explicit = candidate.videoId || candidate.id;
        const id = typeof explicit === 'string' && VIDEO_ID.test(explicit) ? explicit : idFor(item.id, label);
        toId.set(label, id);
        toLabel.set(id, label);
    };
    for (const spec of [item.songs, item.videos, item.ytsearch]) {
        for (const list of listsOf(spec)) list.forEach(note);
    }
    (item.seed || []).forEach(note);
    // A recorded response names its videos by their real ids; anywhere else a
    // name the case never declared is a typo, and a typo in "accept" would
    // silently turn a right answer into a wrong one.
    const recorded = item.origin === 'journal' || [item.songs, item.videos, item.ytsearch].some((spec) => spec && spec.fixture);
    return {
        id: (label) => {
            if (toId.has(label)) return toId.get(label);
            if (recorded && VIDEO_ID.test(String(label))) return String(label);
            throw new Error(`${item.id}: "${label}" is not one of this case's candidates`);
        },
        label: (id) => toLabel.get(id) || id
    };
}

// The shapes a case may give a source's results in:
//   [ ... ]                     the same results whatever is asked
//   { "calls": [[...], [...]] } the nth search gets the nth list (then nothing)
//   { "queries": { "q": [...] } } by exact query, "*" for any other
//   { "fixture": "file.json" }  a recorded response from tests/fixtures
function listsOf(spec) {
    if (!spec) return [];
    if (Array.isArray(spec)) return [spec];
    if (Array.isArray(spec.calls)) return spec.calls;
    if (spec.queries && typeof spec.queries === 'object') return Object.values(spec.queries);
    return [];
}

function pick(spec, query, callIndex) {
    if (!spec) return [];
    if (Array.isArray(spec)) return spec;
    if (Array.isArray(spec.calls)) return spec.calls[callIndex] || [];
    if (spec.queries && typeof spec.queries === 'object') {
        if (Object.hasOwn(spec.queries, query)) return spec.queries[query];
        return spec.queries['*'] || [];
    }
    return [];
}

// --- Rendering a case's results as the upstream would send them -----------------

const durationText = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

const linked = (text, browseId) => ({ text, navigationEndpoint: { browseEndpoint: { browseId } } });

/**
 * One search result as YouTube Music's InnerTube API lays it out, so the
 * engine's own parser (innertube.parseResults) reads it. `kind` is the filter
 * that was asked: a songs row carries the album, a videos row the view count.
 */
function renderItem(candidate, videoId, kind) {
    const type = candidate.type || (kind === 'videos' ? 'omv' : 'atv');
    const meta = [];
    (candidate.artists || []).forEach((name, i) => {
        if (i > 0) meta.push({ text: i === candidate.artists.length - 1 ? ' & ' : ', ' });
        meta.push(linked(name, `UC${'x'.repeat(21)}${i}`));
    });
    if (candidate.album) meta.push({ text: ' • ' }, linked(candidate.album, 'MPREb_evalalbum'));
    if (kind === 'videos' && candidate.plays) meta.push({ text: ' • ' }, { text: `${candidate.plays} views` });
    if (candidate.dur !== undefined && candidate.dur !== null) meta.push({ text: ' • ' }, { text: durationText(candidate.dur) });
    const column = (runs) => ({ musicResponsiveListItemFlexColumnRenderer: { text: { runs } } });
    const watchEndpoint = { videoId };
    if (TYPE_NAMES[type]) {
        watchEndpoint.watchEndpointMusicSupportedConfigs = { watchEndpointMusicConfig: { musicVideoType: TYPE_NAMES[type] } };
    }
    const columns = [column([{ text: candidate.title, navigationEndpoint: { watchEndpoint } }]), column(meta)];
    if (kind !== 'videos' && candidate.plays) columns.push(column([{ text: `${candidate.plays} plays` }]));
    return { musicResponsiveListItemRenderer: { flexColumns: columns, playlistItemData: { videoId } } };
}

function renderInnertube(candidates, ids, kind) {
    const contents = (candidates || []).map((c) => renderItem(c, ids.id(c.label || c.videoId), kind));
    return JSON.stringify({
        contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents } }] } } } }] } }
    });
}

/** yt-dlp's flat-playlist output: one JSON object per line. */
function renderYtsearch(entries, ids) {
    return (entries || []).map((e) => JSON.stringify({
        _type: 'url',
        ie_key: 'Youtube',
        id: ids.id(e.label || e.id),
        title: e.title,
        duration: e.dur ?? null,
        channel: e.channel ?? null,
        uploader: e.channel ?? null,
        view_count: e.views ?? null,
        live_status: e.live ?? null,
        // yt-dlp emits true or null, never false.
        channel_is_verified: e.verified === true ? true : null
    })).join('\n');
}

const response = (status, text, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => text
});

// --- Running ------------------------------------------------------------------

function trackOf(item) {
    // "externalId" is where a case made from the log keeps the track's real id.
    const { externalId, ...track } = item.track;
    return { source: 'deezer', id: externalId || `eval-${item.id}`, ...track };
}

async function seed(db, item, ids) {
    for (const [i, row] of (item.seed || []).entries()) {
        const source = await db.get('SELECT id FROM sources WHERE name = ?', [row.source || 'deezer']);
        await db.run(
            `INSERT INTO track_matches (source_id, external_id, isrc, status, video_id, score, method, checked_at, duration_sec)
             VALUES (?, ?, ?, 'matched', ?, ?, ?, ?, ?)`,
            [source.id, `seed-${item.id}-${i}`, row.isrc, ids.id(row.label), row.score ?? 100, row.method || 'ytmusic', Date.now(), row.durationSec ?? null]
        );
    }
}

function classify(item, entry, ids) {
    const accept = new Set(item.accept.map((label) => ids.id(label)));
    const status = entry ? entry.status : 'error';
    const picked = entry && entry.videoId ? entry.videoId : null;
    const wantedStatus = item.expectStatus || (accept.size ? 'matched' : 'not_found');
    let outcome;
    if (status === 'matched') {
        outcome = accept.has(picked) ? 'correct_match' : 'wrong_match';
    } else if (wantedStatus === status) {
        outcome = 'correct_reject';
    } else if (status === 'error') {
        outcome = 'error';
    } else {
        outcome = accept.size ? 'miss' : 'wrong_status';
    }
    const preferred = item.prefer ? picked === ids.id(item.prefer) : null;
    return { outcome, pass: outcome === 'correct_match' || outcome === 'correct_reject', preferred };
}

/**
 * Runs one case through the real engine. Returns
 * { id, outcome, pass, picked, status, score, method, searches, ytdlp, reasons }.
 */
async function runCase(db, item) {
    const ids = idMap(item);
    const sent = { songs: 0, videos: 0 };
    const entries = [];
    const savedEnv = Object.fromEntries(ENGINE_ENV.map((key) => [key, process.env[key]]));
    const savedFetch = innertube.http.fetch;
    const savedExec = ytsearch.runner.exec;
    const savedSink = journal.hooks.sink;
    const savedWarn = console.warn;

    for (const key of ENGINE_ENV) delete process.env[key];
    Object.assign(process.env, item.env || {});
    matcher._internals.resetForTests();
    console.warn = () => {};
    journal.hooks.sink = (entry) => entries.push(entry);

    innertube.http.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        const kind = body.params === innertube.VIDEOS_PARAMS ? 'videos' : 'songs';
        const callIndex = sent[kind]++;
        if (item.innertube === 'down') throw new TypeError('fetch failed');
        if (item.innertube === 'rate_limited') return response(429, '', { 'retry-after': '30' });
        if (item.innertube === 'http500') return response(500, 'Internal error');
        const spec = item[kind];
        if (spec && spec.fixture) return response(200, fs.readFileSync(path.join(FIXTURES_DIR, spec.fixture), 'utf8'));
        return response(200, renderInnertube(pick(spec, body.query, callIndex), ids, kind));
    };
    ytsearch.runner.exec = async () => {
        if (item.ytsearch && item.ytsearch.fixture) return fs.readFileSync(path.join(FIXTURES_DIR, item.ytsearch.fixture), 'utf8');
        if (!item.ytsearch) throw new Error('yt-dlp has nothing recorded for this case');
        return renderYtsearch(item.ytsearch, ids);
    };

    try {
        await seed(db, item, ids);
        await matcher.resolve(db, trackOf(item));
    } finally {
        innertube.http.fetch = savedFetch;
        ytsearch.runner.exec = savedExec;
        journal.hooks.sink = savedSink;
        console.warn = savedWarn;
        for (const key of [...ENGINE_ENV, ...Object.keys(item.env || {})]) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        matcher._internals.resetForTests();
    }

    const entry = entries[entries.length - 1] || null;
    const verdict = classify(item, entry, ids);
    // Why each right answer lost, when it did: the scorer's reasons for it.
    const reasons = {};
    if (entry && !verdict.pass) {
        for (const label of item.accept) {
            const v = entry.verdicts.find((x) => x.videoId === ids.id(label));
            reasons[label] = v ? (v.reasons || []) : ['not_returned'];
        }
    }
    return {
        id: item.id,
        tags: item.tags || [],
        origin: item.origin || 'constructed',
        ...verdict,
        status: entry ? entry.status : 'error',
        picked: entry && entry.videoId ? ids.label(entry.videoId) : null,
        score: entry ? entry.score : null,
        method: entry ? entry.method : null,
        searches: entry ? entry.cost.innertube : 0,
        ytdlp: entry ? entry.cost.ytdlp : 0,
        reasons
    };
}

const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

function summarize(results, cases) {
    const count = (fn) => results.filter(fn).length;
    const byId = new Map(cases.map((c) => [c.id, c]));
    const answerable = count((r) => byId.get(r.id).accept.length > 0);
    const correctMatch = count((r) => r.outcome === 'correct_match');
    const wrongMatch = count((r) => r.outcome === 'wrong_match');
    const withPrefer = results.filter((r) => r.preferred !== null);
    const searches = results.reduce((n, r) => n + r.searches, 0);
    const ytdlp = results.reduce((n, r) => n + r.ytdlp, 0);
    const searched = count((r) => r.searches > 0 || r.ytdlp > 0);
    const distribution = {};
    for (const r of results) distribution[r.searches] = (distribution[r.searches] || 0) + 1;
    // What an answer costs by how it ended: a miss runs the whole query
    // sequence, a hit usually stops at the first search.
    const byStatus = {};
    for (const r of results) {
        const t = byStatus[r.status] = byStatus[r.status] || { cases: 0, innertubeSearches: 0, ytdlpRuns: 0 };
        t.cases += 1;
        t.innertubeSearches += r.searches;
        t.ytdlpRuns += r.ytdlp;
    }
    for (const t of Object.values(byStatus)) t.searchesPerCase = ratio(t.innertubeSearches, t.cases);

    const tags = {};
    for (const r of results) {
        for (const tag of r.tags) {
            tags[tag] = tags[tag] || { cases: 0, passed: 0, wrongMatch: 0 };
            tags[tag].cases += 1;
            if (r.pass) tags[tag].passed += 1;
            if (r.outcome === 'wrong_match') tags[tag].wrongMatch += 1;
        }
    }
    const origins = {};
    for (const r of results) {
        origins[r.origin] = origins[r.origin] || { cases: 0, passed: 0 };
        origins[r.origin].cases += 1;
        if (r.pass) origins[r.origin].passed += 1;
    }

    return {
        cases: results.length,
        passed: count((r) => r.pass),
        passRate: ratio(count((r) => r.pass), results.length),
        outcomes: {
            correct_match: correctMatch,
            correct_reject: count((r) => r.outcome === 'correct_reject'),
            wrong_match: wrongMatch,
            miss: count((r) => r.outcome === 'miss'),
            wrong_status: count((r) => r.outcome === 'wrong_status'),
            error: count((r) => r.outcome === 'error')
        },
        // Of the tracks it played something for, how often it was the right thing.
        precision: ratio(correctMatch, correctMatch + wrongMatch),
        // Of the tracks whose right recording was among the results, how many it found.
        recall: ratio(correctMatch, answerable),
        preferredPicked: withPrefer.length ? { of: withPrefer.length, picked: withPrefer.filter((r) => r.preferred).length } : null,
        cost: {
            innertubeSearches: searches,
            ytdlpRuns: ytdlp,
            searchesPerCase: ratio(searches, results.length),
            searchesPerSearchedCase: ratio(searches, searched),
            casesBySearchCount: distribution,
            byStatus
        },
        origins,
        tags
    };
}

/**
 * Runs every case; returns { results, summary }. Each case gets a database of
 * its own: a row left by one case (a match, an ISRC) must never answer another.
 */
async function runAll(cases = loadCases()) {
    const savedLog = console.log;
    console.log = () => {}; // initDB announces itself once per database
    try {
        const results = [];
        for (const item of cases) {
            const db = await initDB(':memory:');
            try {
                results.push(await runCase(db, item));
            } finally {
                await db.close();
            }
        }
        return { results, summary: summarize(results, cases) };
    } finally {
        console.log = savedLog;
    }
}

// --- Baseline -------------------------------------------------------------------

const baselineRow = (r) => ({ outcome: r.outcome, picked: r.picked, searches: r.searches, ytdlp: r.ytdlp });

// The robustness suite is ~1,700 generated checks; the baseline keeps its
// totals, the tally per rewrite and the ids that fail, not every row.
const robustnessRow = (r) => ({
    pairs: r.pairs,
    checks: r.checks,
    passed: r.passed,
    rewrites: r.rewrites,
    failing: r.failures.map((f) => f.id).sort()
});

function toBaseline({ results, summary, robustness }) {
    return {
        summary,
        cases: Object.fromEntries(results.map((r) => [r.id, baselineRow(r)])),
        ...(robustness ? { robustness: robustnessRow(robustness) } : {})
    };
}

function readBaseline(file = BASELINE_FILE) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

const PASSING = new Set(['correct_match', 'correct_reject']);

/**
 * Compares a run with the committed baseline. `regressions` are cases that
 * passed and no longer do (or now play the wrong video); `improvements` are
 * the reverse; `changed` covers a different pick or search count with the same
 * verdict; `added` / `removed` are cases the baseline does not know or no
 * longer has. Any entry in any list means the baseline is out of date.
 */
function compare(results, baseline) {
    const diff = { regressions: [], improvements: [], changed: [], added: [], removed: [] };
    const known = (baseline && baseline.cases) || {};
    const seen = new Set();
    for (const r of results) {
        seen.add(r.id);
        const before = known[r.id];
        if (!before) { diff.added.push(r.id); continue; }
        const now = baselineRow(r);
        const was = PASSING.has(before.outcome);
        const is = PASSING.has(now.outcome);
        if (was && !is) diff.regressions.push(`${r.id}: ${before.outcome} -> ${now.outcome}`);
        else if (!was && is) diff.improvements.push(`${r.id}: ${before.outcome} -> ${now.outcome}`);
        else if (before.outcome !== now.outcome && now.outcome === 'wrong_match') diff.regressions.push(`${r.id}: ${before.outcome} -> wrong_match`);
        else if (JSON.stringify(before) !== JSON.stringify(now)) diff.changed.push(`${r.id}: ${JSON.stringify(before)} -> ${JSON.stringify(now)}`);
    }
    for (const id of Object.keys(known)) if (!seen.has(id)) diff.removed.push(id);
    return diff;
}

/** The same comparison for the robustness suite: which checks fail now and did not, and the reverse. */
function compareRobustness(robustness, baseline) {
    const before = new Set((baseline && baseline.robustness && baseline.robustness.failing) || []);
    const now = new Set(robustness.failures.map((f) => f.id));
    const diff = { regressions: [], improvements: [], changed: [], added: [], removed: [] };
    for (const id of now) if (!before.has(id)) diff.regressions.push(`robustness: ${id}`);
    for (const id of before) if (!now.has(id)) diff.improvements.push(`robustness: ${id}`);
    const was = baseline && baseline.robustness;
    if (!was) diff.added.push('robustness suite');
    else if (was.checks !== robustness.checks || was.pairs !== robustness.pairs) {
        diff.changed.push(`robustness: ${was.checks} checks over ${was.pairs} pairs -> ${robustness.checks} over ${robustness.pairs}`);
    }
    return diff;
}

const mergeDiffs = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, [...a[key], ...b[key]]]));

const isClean = (diff) => Object.values(diff).every((list) => list.length === 0);

module.exports = {
    loadCases,
    runCase,
    runAll,
    summarize,
    compare,
    compareRobustness,
    mergeDiffs,
    isClean,
    toBaseline,
    readBaseline,
    idMap,
    idFor,
    renderInnertube,
    renderYtsearch,
    CASES_DIR,
    BASELINE_FILE
};
