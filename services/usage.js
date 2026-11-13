// Usage meter: what the app spends on services it does not own.
//
// Nothing here is billed in money. What runs out is allowance and time:
//   - the YouTube Data API gives one Google project 10,000 quota units a day,
//     and a search takes 100 of them (YOUTUBE_API_UNITS below);
//   - YouTube Music's private search (services/matcher/innertube.js) answers
//     429/403 when one address asks too often;
//   - a yt-dlp run is seconds of waiting before a track plays.
// So every such call is counted here with the time it took, per day, and
// GET /api/system/usage reports the totals and what is left of the quota.
//
// record() only adds to a small in-memory map; the totals reach SQLite
// (usage_daily) in one batch every FLUSH_MS and whenever a report is read, so
// metering never adds a disk write to the call it meters. Without attach()
// (tests, the eval runner) it is memory only.

// Quota units per YouTube Data API method, from Google's quota calculator
// (developers.google.com/youtube/v3/determine_quota_cost). A request is
// charged whether or not it succeeds.
const YOUTUBE_API_UNITS = Object.freeze({
    'search.list': 100,
    'videos.list': 1,
    'videos.rate': 50,
    'playlists.list': 1,
    'playlistItems.list': 1
});
const DEFAULT_DAILY_QUOTA = 10000;
const FLUSH_MS = 30 * 1000;
const MAX_REPORT_DAYS = 90;
const METRIC_NAME = /^[a-z0-9_.]{1,64}$/;
// Google's quota resets at midnight Pacific time, so that is the day every
// total is kept under: "today" in a report is the quota's today.
const QUOTA_TIME_ZONE = 'America/Los_Angeles';

let dayFormat = null;

function dayOf(date = new Date()) {
    try {
        if (!dayFormat) {
            dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: QUOTA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
        }
        return dayFormat.format(date);
    } catch {
        // A runtime without time zone data: UTC is off by a few hours, not wrong.
        return date.toISOString().slice(0, 10);
    }
}

function dailyQuota() {
    const n = Number(process.env.YOUTUBE_API_DAILY_QUOTA);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_QUOTA;
}

const empty = () => ({ count: 0, ms: 0, units: 0 });
const amount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

// metric -> totals since the process started.
const sinceStart = new Map();
// "day|metric" -> totals not yet written to the database.
let pending = new Map();
let startedAt = Date.now();
let db = null;
let timer = null;

function add(map, key, delta) {
    const total = map.get(key) || empty();
    total.count += delta.count;
    total.ms += delta.ms;
    total.units += delta.units;
    map.set(key, total);
}

// record() runs on every cached answer, and formatting a date in another time
// zone is the slowest thing it would do: the day is looked up at most once
// every DAY_MEMO_MS, which can file an event up to that long after midnight
// under the day before.
const DAY_MEMO_MS = 30 * 1000;
let today = { day: '', until: 0 };

function currentDay() {
    const now = Date.now();
    if (now >= today.until) today = { day: dayOf(new Date(now)), until: now + DAY_MEMO_MS };
    return today.day;
}

/**
 * Counts one event: `count` occurrences (default 1) that took `ms` in total
 * and spent `units` of a quota. Never throws; a bad metric name is ignored.
 */
function record(metric, { count = 1, ms = 0, units = 0 } = {}) {
    if (typeof metric !== 'string' || !METRIC_NAME.test(metric)) return;
    const delta = { count: amount(count), ms: amount(ms), units: amount(units) };
    add(sinceStart, metric, delta);
    add(pending, `${currentDay()}|${metric}`, delta);
}

/** Counts a YouTube Data API call ("search.list") with its quota cost. */
function recordYouTubeApi(method) {
    const units = Object.hasOwn(YOUTUBE_API_UNITS, method) ? YOUTUBE_API_UNITS[method] : 1;
    record(`youtube_api.${method.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()}`, { units });
}

/** Writes what has been counted since the last flush. Safe to call any time. */
async function flush(target = db) {
    if (!target || pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    try {
        for (const [key, total] of batch) {
            const [day, metric] = key.split('|');
            await target.run(
                `INSERT INTO usage_daily (day, metric, count, ms, units) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(day, metric) DO UPDATE SET
                     count = usage_daily.count + excluded.count,
                     ms = usage_daily.ms + excluded.ms,
                     units = usage_daily.units + excluded.units`,
                [day, metric, total.count, total.ms, total.units]
            );
            batch.delete(key);
        }
    } catch (err) {
        // Whatever was not written goes back in for the next attempt.
        for (const [key, total] of batch) add(pending, key, total);
        console.warn(`usage: totals could not be saved: ${err && err.message}`);
    }
}

/** Starts saving the totals in `database` (the app's SQLite handle). */
function attach(database) {
    db = database;
    if (timer) clearInterval(timer);
    timer = setInterval(() => { flush(); }, FLUSH_MS);
    timer.unref();
}

async function detach() {
    if (timer) clearInterval(timer);
    timer = null;
    await flush();
    db = null;
}

const asObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { ...v }]));

/** Totals since this process started (memory only). */
function snapshot() {
    return { since: new Date(startedAt).toISOString(), metrics: asObject(sinceStart) };
}

function sumUnits(metrics, prefix) {
    let units = 0;
    for (const [metric, total] of Object.entries(metrics || {})) {
        if (metric.startsWith(prefix)) units += total.units;
    }
    return units;
}

// What a day's counters mean for the match engine, so a reader does not have
// to do the division: how many tracks needed a search, what each cost, and how
// much the cache saved.
function matchSummary(metrics) {
    const get = (name) => (metrics && metrics[name]) || empty();
    const fresh = ['matched', 'not_found', 'error'].reduce((n, status) => n + get(`match.${status}`).count, 0);
    const cacheHits = get('match.cache_hit').count;
    const isrcReuse = get('match.isrc_reuse').count;
    const searches = get('innertube.search');
    const ytdlp = get('ytdlp.search');
    const searched = fresh - isrcReuse;
    const asked = fresh + cacheHits;
    return {
        asked,
        answeredFromCache: cacheHits,
        answeredByIsrc: isrcReuse,
        searched: Math.max(0, searched),
        cacheHitRate: asked ? Math.round((cacheHits / asked) * 1000) / 1000 : null,
        innertubeSearches: searches.count,
        innertubeSearchesPerSearchedTrack: searched > 0 ? Math.round((searches.count / searched) * 100) / 100 : null,
        innertubeMsPerSearch: searches.count ? Math.round(searches.ms / searches.count) : null,
        ytdlpSearches: ytdlp.count,
        ytdlpMsPerSearch: ytdlp.count ? Math.round(ytdlp.ms / ytdlp.count) : null,
        rateLimited: get('innertube.rate_limited').count
    };
}

/**
 * The saved totals for the last `days` days (today first), today's YouTube
 * Data API quota position, and the totals since the process started.
 */
async function report(database, { days = 7 } = {}) {
    const wanted = Math.max(1, Math.min(MAX_REPORT_DAYS, Math.floor(Number(days)) || 7));
    const source = database || db;
    await flush(source);
    const byDay = new Map();
    if (source) {
        const rows = await source.all(
            `SELECT day, metric, count, ms, units FROM usage_daily
             WHERE day IN (SELECT DISTINCT day FROM usage_daily ORDER BY day DESC LIMIT ?)
             ORDER BY day DESC, metric`,
            [wanted]
        );
        for (const row of rows) {
            if (!byDay.has(row.day)) byDay.set(row.day, {});
            byDay.get(row.day)[row.metric] = { count: row.count, ms: row.ms, units: row.units };
        }
    }
    const today = dayOf();
    const todayMetrics = byDay.get(today) || (source ? {} : snapshot().metrics);
    const used = sumUnits(todayMetrics, 'youtube_api.');
    const quota = dailyQuota();
    return {
        today,
        timeZone: QUOTA_TIME_ZONE,
        youtubeApi: { unitsUsed: used, dailyQuota: quota, unitsLeft: Math.max(0, quota - used), unitCosts: YOUTUBE_API_UNITS },
        matching: matchSummary(todayMetrics),
        days: [...byDay].map(([day, metrics]) => ({ day, metrics })),
        process: snapshot()
    };
}

// Tests only.
function _resetForTests() {
    sinceStart.clear();
    today = { day: '', until: 0 };
    pending = new Map();
    startedAt = Date.now();
    if (timer) clearInterval(timer);
    timer = null;
    db = null;
}

module.exports = {
    record,
    recordYouTubeApi,
    attach,
    detach,
    flush,
    snapshot,
    report,
    matchSummary,
    dayOf,
    dailyQuota,
    YOUTUBE_API_UNITS,
    QUOTA_TIME_ZONE,
    _resetForTests
};
