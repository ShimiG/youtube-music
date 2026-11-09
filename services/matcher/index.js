// The match engine: decides which YouTube video plays for a track from a
// match-mode source (Spotify today) and remembers the decision.
//
// Why a cache table, a queue and de-duplication: a playlist page asks for up
// to 50 matches at once, an InnerTube search costs ~0.5 s and a yt-dlp search
// ~9 s, and the right answer for a track only changes when a person overrides
// it. So every decision is persisted in track_matches, concurrent asks for the
// same track share one in-flight search, and the number of simultaneous
// upstream calls is bounded so one big playlist cannot hammer YouTube (or trip
// its rate limits) all at once.
//
// Statuses: matched (final), not_found (retried after MATCH_NOT_FOUND_TTL_MS),
// error (retried after MATCH_ERROR_TTL_MS). resolveMany/filterPlayable also
// report pending for tracks whose search is still running when the request
// budget runs out; those finish in the background and land in the table.
const { normalizeText, parseTitle, artistsOf, primaryArtist } = require('./normalize');
const { pickBest, durationTolerance } = require('./score');
const innertube = require('./innertube');
const ytsearch = require('./ytsearch');

const { MatchSourceError } = innertube;

// Sources that play through a matched video even before their provider exists
// in the registry (Spotify's provider lands in the next task). Providers may
// also declare `capabilities.playback === 'match'`.
const CONSTANT_MATCH_SOURCES = Object.freeze(['spotify']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const REPORT_REASONS = new Set(['wrong_match', 'unavailable', 'other']);
const MAX_QUERY_CHARS = 200;
const MAX_STORED_CANDIDATES = 5;
// SQLite binds at most 32766 variables per statement. A library page is far
// smaller, so a cache read is one query per source in practice; the chunking
// only exists so an absurdly long list cannot produce a SQL error.
const MAX_IDS_PER_QUERY = 900;
// Titles and names are parsed with regular expressions; the HTTP route caps
// them, but a track can also arrive from a custom playlist row or a provider,
// so the engine bounds what it parses itself.
const MAX_TEXT_CHARS = 300;
const MAX_ARTISTS = 20;
const MAX_ARTIST_CHARS = 200;
// setTimeout treats delays above 2^31-1 ms as 1 ms; anything that large (or
// non-finite) is "no budget".
const MAX_TIMEOUT_MS = 2147483647;
// How long InnerTube is left alone after it answered 429/403 without a
// Retry-After header.
const DEFAULT_BACKOFF_MS = 60 * 1000;
// Tasks allowed to wait for a slot before new ones are refused outright. A
// backlog deeper than this means callers are producing work faster than
// YouTube will ever take it; failing fast keeps a request from queueing forever.
const INNERTUBE_MAX_WAITING = 500;
const YTSEARCH_MAX_WAITING = 50;

// --- Config: read at call time so operators and tests can change it live ----

function envNumber(name, fallback, min) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

const concurrency = () => envNumber('MATCH_CONCURRENCY', 4, 1);
const requestBudgetMs = () => envNumber('MATCH_REQUEST_BUDGET_MS', 25000, 1);
const notFoundTtlMs = () => envNumber('MATCH_NOT_FOUND_TTL_MS', 30 * 24 * 60 * 60 * 1000, 0);
const errorTtlMs = () => envNumber('MATCH_ERROR_TTL_MS', 10 * 60 * 1000, 0);

// --- Queue --------------------------------------------------------------------

// A FIFO with a bounded number of slots and a bounded backlog. `slots` is a
// function so the limit follows the env var without a restart.
function createQueue(slots, { maxWaiting = Infinity } = {}) {
    const waiting = [];
    let active = 0;
    let peak = 0;

    function pump() {
        while (active < slots() && waiting.length) {
            const { task, resolve, reject } = waiting.shift();
            active += 1;
            peak = Math.max(peak, active);
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    active -= 1;
                    pump();
                });
        }
    }

    return {
        run(task) {
            return new Promise((resolve, reject) => {
                if (waiting.length >= maxWaiting) {
                    reject(new MatchSourceError('UNAVAILABLE', `match queue backlog is full (${waiting.length} waiting)`));
                    return;
                }
                waiting.push({ task, resolve, reject });
                pump();
            });
        },
        get active() { return active; },
        get waiting() { return waiting.length; },
        get peak() { return peak; },
        get maxWaiting() { return maxWaiting; },
        // Drops the backlog, telling each waiter so no promise is stranded.
        // Running tasks are left alone: `active` follows them down on its own,
        // and zeroing it here would let it go negative when they finish.
        reset() {
            const dropped = waiting.splice(0, waiting.length);
            for (const { reject } of dropped) reject(new Error('queue reset'));
            peak = 0;
        }
    };
}

const innertubeQueue = createQueue(concurrency, { maxWaiting: INNERTUBE_MAX_WAITING });
// yt-dlp spawns a process and takes ~9 s; one at a time keeps it a fallback
// rather than a load generator.
const ytsearchQueue = createQueue(() => 1, { maxWaiting: YTSEARCH_MAX_WAITING });

// key -> the promise of the resolution currently running for that track.
const inFlight = new Map();

// Keys whose row was just forgotten: their next resolution must search for
// real instead of copying a sibling's answer by ISRC (that is what "forget"
// is for when the copied answer was the wrong one).
const forgotten = new Set();

// --- InnerTube back-off ---------------------------------------------------------

// Epoch ms until which InnerTube is not asked anything. A 429/403 is YouTube
// telling us to slow down, not an outage: during the episode every match-mode
// track becomes `error` (retried after MATCH_ERROR_TTL_MS) and the yt-dlp
// fallback does not run either, because 9 s of yt-dlp per track would turn a
// short back-off into a long one.
let innertubeBlockedUntil = 0;

const isRateLimited = (err) => Boolean(err) && err.code === 'RATE_LIMITED';
const innertubeBlocked = () => Date.now() < innertubeBlockedUntil;

function noteRateLimit(err) {
    const retryAfterMs = Number(err.retryAfterMs);
    innertubeBlockedUntil = Date.now() + (Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : DEFAULT_BACKOFF_MS);
}

function blockedError() {
    return new MatchSourceError('RATE_LIMITED', 'YouTube Music search is backing off after a rate limit', {
        retryAfterMs: Math.max(0, innertubeBlockedUntil - Date.now())
    });
}

// Every InnerTube call goes through here: it is refused while the back-off
// lasts (checked again inside the slot, since the block may have started
// while the task waited) and a RATE_LIMITED answer starts a new back-off.
async function viaInnertube(task) {
    if (innertubeBlocked()) throw blockedError();
    try {
        return await innertubeQueue.run(() => {
            if (innertubeBlocked()) throw blockedError();
            return task();
        });
    } catch (err) {
        if (isRateLimited(err) && !innertubeBlocked()) noteRateLimit(err);
        throw err;
    }
}

// --- Sources --------------------------------------------------------------------

function matchSources() {
    const names = new Set(CONSTANT_MATCH_SOURCES);
    // Required lazily: the registry pulls in every provider (and googleapis),
    // and a future match-mode provider may itself import this engine.
    const { listProviders } = require('../../providers');
    for (const provider of listProviders()) {
        if (provider && provider.name && provider.capabilities && provider.capabilities.playback === 'match') {
            names.add(provider.name);
        }
    }
    return [...names];
}

function isMatchSource(name) {
    return typeof name === 'string' && matchSources().includes(name);
}

// sources.name -> sources.id. The table never changes at runtime, so one read
// per source per process is enough.
const sourceIds = new Map();

async function sourceIdOf(db, source) {
    if (sourceIds.has(source)) return sourceIds.get(source);
    const row = await db.get('SELECT id FROM sources WHERE name = ?', [source]);
    if (!row) {
        // Match rows hang off sources(id): a provider that plays through
        // matching must be registered in config/db.js like the others.
        throw new Error(`Unknown source "${source}": it has no row in the sources table`);
    }
    sourceIds.set(source, row.id);
    return row.id;
}

// --- Rows -------------------------------------------------------------------------

function keyOf(track) {
    return `${track.source}:${track.id}`;
}

function parseCandidates(json) {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// A person's decision, whether it was attributed to a user or not: the same
// predicate persist() applies in SQL.
const isManual = (row) => (row.override_by !== null && row.override_by !== undefined) || row.method === 'manual';

function resultFromRow(row, fromCache) {
    return {
        status: row.status,
        videoId: row.video_id || null,
        score: row.score === null || row.score === undefined ? null : row.score,
        method: row.method || null,
        candidates: parseCandidates(row.candidates_json),
        fromCache
    };
}

function matchFromRow(source, row) {
    return {
        source,
        externalId: row.external_id,
        status: row.status,
        videoId: row.video_id || null,
        score: row.score === null || row.score === undefined ? null : row.score,
        method: row.method || null,
        candidates: parseCandidates(row.candidates_json),
        checkedAt: row.checked_at,
        manual: isManual(row),
        isrc: row.isrc || null
    };
}

// Whether a cached row still answers the question. A person's choice is final
// whatever its status; an automatic match is final; a miss or an error is
// retried once its TTL has passed.
function isFresh(row, now = Date.now()) {
    if (!row) return false;
    if (isManual(row) || row.status === 'matched') return true;
    const age = now - Number(row.checked_at || 0);
    if (row.status === 'not_found') return age < notFoundTtlMs();
    if (row.status === 'error') return age < errorTtlMs();
    return false;
}

function readRow(db, sourceId, externalId) {
    return db.get(
        `SELECT source_id, external_id, isrc, status, video_id, score, method, candidates_json, checked_at, override_by, duration_sec
         FROM track_matches WHERE source_id = ? AND external_id = ?`,
        [sourceId, externalId]
    );
}

function externalIdOf(track) {
    return String(track.id);
}

function assertTrack(track) {
    if (!track || typeof track.source !== 'string' || track.id === undefined || track.id === null || track.id === '') {
        throw new TypeError('A track needs a source and an id to be matched');
    }
}

function badRequest(message) {
    const err = new TypeError(message);
    err.code = 'MATCH_BAD_REQUEST';
    return err;
}

// --- Input bounds --------------------------------------------------------------

function clipText(value, max) {
    if (value === null || value === undefined) return null;
    const text = typeof value === 'string' ? value : String(value);
    return text.slice(0, max);
}

// A copy of the track with every parsed field bounded. Identity fields are
// untouched so the row and the in-flight key still name the same track.
function boundedTrack(track) {
    const bounded = {
        ...track,
        title: clipText(track.title, MAX_TEXT_CHARS) || '',
        artist: clipText(track.artist, MAX_TEXT_CHARS),
        album: clipText(track.album, MAX_TEXT_CHARS)
    };
    if (Array.isArray(track.artists)) {
        bounded.artists = track.artists
            .filter((a) => typeof a === 'string' && a.trim())
            .slice(0, MAX_ARTISTS)
            .map((a) => a.slice(0, MAX_ARTIST_CHARS));
    }
    return bounded;
}

// --- Searching -----------------------------------------------------------------

function clip(parts) {
    return parts.filter(Boolean).map(String).join(' ').trim().slice(0, MAX_QUERY_CHARS);
}

// The same video can come back from several queries (and from yt-dlp as well
// as InnerTube); the first sighting wins so its InnerTube classification is
// kept. Returns the candidates that were actually new.
function addCandidates(collected, seen, more) {
    const added = [];
    for (const candidate of more || []) {
        if (!candidate || !candidate.videoId || seen.has(candidate.videoId)) continue;
        seen.add(candidate.videoId);
        collected.push(candidate);
        added.push(candidate);
    }
    return added;
}

// Runs the query sequence and the fallback. Returns everything collected,
// ranked, plus the errors met on the way; the caller decides what the outcome
// means. Candidates are scored as they arrive, so each query's results are
// evaluated once, and the track's title is parsed once per pickBest call.
async function searchCandidates(track) {
    const artists = artistsOf(track) || [];
    const artist = primaryArtist(track) || artists[0] || '';
    const title = track.title || '';
    const core = parseTitle(title, artists).core;
    // Raw strings on purpose: the probe showed the accent-less form of a title
    // missing a song the accented form found.
    const rawQuery = clip([artist, title]);
    const collected = [];
    const seen = new Set();
    const errors = [];
    const asked = new Set();
    let ranked = { best: null, evaluated: [] };

    const consider = (more) => {
        const fresh = addCandidates(collected, seen, more);
        if (fresh.length) ranked = pickBest(track, fresh, { evaluated: ranked.evaluated });
    };
    const hasPassing = () => Boolean(ranked.best);
    // The same words in another order or spelling are the same question.
    const isNew = (query) => {
        const norm = normalizeText(query);
        if (!norm || asked.has(norm)) return false;
        asked.add(norm);
        return true;
    };

    try {
        isNew(rawQuery);
        consider(await viaInnertube(() => innertube.searchSongs(rawQuery)));
        if (!hasPassing()) {
            // Spotify's qualifiers ("- Remastered 2011", "(feat. X)") can keep
            // the catalog song out of the top results; retry on the bare title
            // when that actually removes something.
            const coreQuery = clip([artist, core]);
            if (isNew(coreQuery)) consider(await viaInnertube(() => innertube.searchSongs(coreQuery)));
        }
        if (!hasPassing()) {
            // Title first: for a small act sharing a title with a hit ("Get
            // Lucky" by Funk Punk) the artist-first query returns only the
            // hit's entries, while the title-first one surfaces the act's own.
            const reversedQuery = clip([core, artist]);
            if (isNew(reversedQuery)) consider(await viaInnertube(() => innertube.searchSongs(reversedQuery)));
        }
        if (!hasPassing()) {
            consider(await viaInnertube(() => innertube.searchVideos(rawQuery)));
        }
    } catch (err) {
        errors.push(err);
    }

    // yt-dlp is ~20x slower and has no official/UGC classification, so it only
    // covers an InnerTube outage by default; MATCH_YTDLP_RECALL also lets it
    // look for songs InnerTube did not surface. A rate-limit episode is not an
    // outage: the track waits for the error TTL instead.
    const innertubeFailed = errors.length > 0;
    const rateLimited = errors.some(isRateLimited);
    const wantFallback = ytsearch.isEnabled() && !rateLimited && (innertubeFailed || (!hasPassing() && ytsearch.recallEnabled()));
    if (wantFallback) {
        try {
            // The bare title: YouTube titles never contain Spotify's full
            // "(feat. X & Y)" string verbatim, and yt-dlp quotes each phrase.
            consider(await ytsearchQueue.run(() => ytsearch.searchVideos(artist, core || title)));
        } catch (err) {
            errors.push(err);
        }
    }

    return { collected, ranked, errors };
}

const EMPTY = { videoId: null, score: null, method: null };

function warn(track, err) {
    const code = err && (err.code || err.name) ? ` (${err.code || err.name})` : '';
    console.warn(`matcher: ${keyOf(track)} could not be resolved${code}: ${err && err.message}`);
}

async function searchOutcome(track) {
    try {
        const { ranked, errors } = await searchCandidates(track);
        const { best, evaluated } = ranked;
        const candidates = (evaluated || []).slice(0, MAX_STORED_CANDIDATES);
        if (best) {
            const score = Number.isFinite(Number(best.score)) ? Math.round(Number(best.score)) : null;
            const durationSec = Number.isFinite(Number(best.durationSec)) && Number(best.durationSec) > 0 ? Math.round(Number(best.durationSec)) : null;
            return { status: 'matched', videoId: best.videoId, score, method: best.origin === 'ytsearch' ? 'ytsearch' : 'ytmusic', candidates, durationSec };
        }
        if (errors.length) {
            warn(track, errors[0]);
            return { status: 'error', ...EMPTY, candidates };
        }
        return { status: 'not_found', ...EMPTY, candidates };
    } catch (err) {
        warn(track, err);
        return { status: 'error', ...EMPTY, candidates: [] };
    }
}

// The same recording under another id or source (Spotify and Tidal share
// ISRCs) has already been matched: copy that answer instead of searching.
// Only first-hand answers are copied (a person's choice or a direct search
// result, never a row that was itself a copy, so one wrong copy cannot
// spread), a person's choice is preferred over an automatic one, and the
// sibling's recorded duration must agree with this track's when both are known.
async function reuseByIsrc(db, isrc, sourceId, externalId, trackDurationSec) {
    const rows = await db.all(
        `SELECT video_id, score, duration_sec FROM track_matches
         WHERE isrc = ? AND status = 'matched' AND video_id IS NOT NULL
           AND (method IS NULL OR method != 'isrc')
           AND NOT (source_id = ? AND external_id = ?)
         ORDER BY (override_by IS NOT NULL OR method = 'manual') DESC, checked_at DESC
         LIMIT 5`,
        [isrc, sourceId, externalId]
    );
    const wanted = Number(trackDurationSec);
    const known = Number.isFinite(wanted) && wanted > 0;
    const row = rows.find((r) => {
        const stored = Number(r.duration_sec);
        if (!known || !Number.isFinite(stored) || stored <= 0) return true;
        return Math.abs(stored - wanted) <= durationTolerance();
    });
    if (!row) return null;
    return {
        status: 'matched',
        videoId: row.video_id,
        score: row.score === null || row.score === undefined ? null : row.score,
        method: 'isrc',
        candidates: [],
        durationSec: Number.isFinite(Number(row.duration_sec)) ? row.duration_sec : null
    };
}

// Upsert that leaves a person's decision alone unless `force`. When the row
// was overridden while this search ran, nothing changes and the override is
// what the caller gets back.
async function persist(db, { sourceId, externalId, isrc, status, videoId, score, method, candidates, durationSec = null, force }) {
    const { changes } = await db.run(
        `INSERT INTO track_matches (source_id, external_id, isrc, status, video_id, score, method, candidates_json, checked_at, override_by, duration_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
             isrc = COALESCE(excluded.isrc, track_matches.isrc),
             status = excluded.status,
             video_id = excluded.video_id,
             score = excluded.score,
             method = excluded.method,
             candidates_json = excluded.candidates_json,
             checked_at = excluded.checked_at,
             override_by = NULL,
             duration_sec = excluded.duration_sec
         WHERE (track_matches.override_by IS NULL AND (track_matches.method IS NULL OR track_matches.method != 'manual')) OR ? = 1`,
        [sourceId, externalId, isrc, status, videoId, score, method, candidates.length ? JSON.stringify(candidates) : null, Date.now(), durationSec, force ? 1 : 0]
    );
    if (changes === 0) {
        const row = await readRow(db, sourceId, externalId);
        if (row) return resultFromRow(row, true);
    }
    return { status, videoId, score, method, candidates, fromCache: false };
}

async function resolveFresh(db, track, sourceId, force) {
    const externalId = externalIdOf(track);
    const isrc = track.isrc ? String(track.isrc) : null;
    // A forced resolution, and the first one after a forget, must look for
    // real: both exist to get rid of an answer, and the sibling with the same
    // ISRC may hold that very answer.
    const skipIsrc = force || forgotten.delete(keyOf(track));
    const outcome = (isrc && !skipIsrc && await reuseByIsrc(db, isrc, sourceId, externalId, track.durationSec)) || await searchOutcome(track);
    return persist(db, { sourceId, externalId, isrc, ...outcome, force });
}

// --- Public API ------------------------------------------------------------------

async function resolve(db, rawTrack, { force = false } = {}) {
    assertTrack(rawTrack);
    const track = boundedTrack(rawTrack);
    const key = keyOf(track);
    if (!force && inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
        const sourceId = await sourceIdOf(db, track.source);
        if (!force) {
            const row = await readRow(db, sourceId, externalIdOf(track));
            if (isFresh(row)) return resultFromRow(row, true);
        }
        return resolveFresh(db, track, sourceId, force);
    })();

    inFlight.set(key, promise);
    try {
        return await promise;
    } finally {
        if (inFlight.get(key) === promise) inFlight.delete(key);
    }
}

// Resolves to `promise`, or to undefined once `ms` has passed, whichever is
// first. The timer is always cleared so nothing keeps the process alive.
function withinBudget(promise, ms) {
    if (!Number.isFinite(ms) || ms > MAX_TIMEOUT_MS) return promise;
    let timer;
    const budget = new Promise((done) => { timer = setTimeout(done, Math.max(0, ms)); });
    return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

async function resolveMany(db, tracks, { timeoutMs = requestBudgetMs() } = {}) {
    const byKey = new Map();
    for (const track of Array.isArray(tracks) ? tracks : []) {
        if (!track || typeof track.source !== 'string' || track.id === undefined || track.id === null || track.id === '') continue;
        const key = keyOf(track);
        if (!byKey.has(key)) byKey.set(key, track);
    }

    const settled = new Map();
    const all = [...byKey].map(([key, track]) => resolve(db, track).then(
        (result) => { settled.set(key, result); },
        (err) => {
            // A DB or programming failure for one track must not sink the
            // whole page; report it like a source error and move on.
            console.warn(`matcher: ${key} failed: ${err && err.message}`);
            settled.set(key, { status: 'error', ...EMPTY, candidates: [], fromCache: false });
        }
    ));

    await withinBudget(Promise.all(all), timeoutMs);
    // Input order, not completion order, so callers can iterate predictably.
    const results = new Map();
    for (const key of byKey.keys()) {
        results.set(key, settled.get(key) || { status: 'pending' });
    }
    return results;
}

// Sources already reported as missing from the sources table, so a
// misconfigured provider is logged once, not once per page.
const warnedSources = new Set();

// Reads every cached row for the match-mode tracks in one query per source,
// instead of one per track. Returns key -> result for the rows still fresh,
// and the sources that could not be looked up at all.
async function lookupCached(db, tracks) {
    const idsBySource = new Map();
    for (const track of tracks) {
        if (track.id === undefined || track.id === null || track.id === '') continue;
        if (!idsBySource.has(track.source)) idsBySource.set(track.source, new Set());
        idsBySource.get(track.source).add(externalIdOf(track));
    }

    const results = new Map();
    const failedSources = new Set();
    const now = Date.now();
    for (const [source, idSet] of idsBySource) {
        let sourceId;
        try {
            sourceId = await sourceIdOf(db, source);
        } catch (err) {
            // A match-mode source without a sources row cannot be matched;
            // its tracks are hidden and counted as errors rather than
            // failing the whole (mixed) page.
            if (!warnedSources.has(source)) {
                warnedSources.add(source);
                console.warn(`matcher: ${err && err.message}`);
            }
            failedSources.add(source);
            continue;
        }
        const ids = [...idSet];
        for (let i = 0; i < ids.length; i += MAX_IDS_PER_QUERY) {
            const chunk = ids.slice(i, i + MAX_IDS_PER_QUERY);
            const rows = await db.all(
                `SELECT external_id, status, video_id, score, method, checked_at, override_by
                 FROM track_matches
                 WHERE source_id = ? AND external_id IN (${chunk.map(() => '?').join(', ')})`,
                [sourceId, ...chunk]
            );
            for (const row of rows) {
                if (isFresh(row, now)) results.set(`${source}:${row.external_id}`, resultFromRow(row, true));
            }
        }
    }
    return { results, failedSources };
}

// Keeps only the tracks that can play: every match-mode track resolves to a
// video or is dropped; tracks from other sources pass through untouched and
// the order never changes. `summary.hidden` counts every match-mode track that
// was dropped, with `pending` and `errors` saying how many of those were not
// definitive misses.
async function filterPlayable(db, tracks, opts = {}) {
    const list = Array.isArray(tracks) ? tracks : [];
    const summary = { total: 0, matched: 0, hidden: 0, pending: 0, errors: 0 };
    const matchable = new Set(matchSources());
    const isMatchTrack = (track) => Boolean(track) && typeof track.source === 'string' && matchable.has(track.source);

    const targets = list.filter(isMatchTrack);
    if (targets.length === 0) return { items: list, summary };

    const { results, failedSources } = await lookupCached(db, targets);
    const missing = [];
    const queued = new Set();
    for (const track of targets) {
        const key = keyOf(track);
        if (results.has(key) || queued.has(key) || track.id === undefined || track.id === null || track.id === '') continue;
        queued.add(key);
        if (failedSources.has(track.source)) {
            results.set(key, { status: 'error', ...EMPTY, candidates: [], fromCache: false });
            continue;
        }
        missing.push(track);
    }
    if (missing.length) {
        for (const [key, result] of await resolveMany(db, missing, { timeoutMs: opts.timeoutMs })) results.set(key, result);
    }

    const items = [];
    for (const track of list) {
        if (!isMatchTrack(track)) {
            items.push(track);
            continue;
        }
        summary.total += 1;
        const result = results.get(keyOf(track)) || { status: 'not_found' };
        if (result.status === 'matched' && result.videoId) {
            summary.matched += 1;
            items.push({
                ...track,
                youtubeId: result.videoId,
                match: { status: 'matched', score: result.score === undefined ? null : result.score, method: result.method || null }
            });
            continue;
        }
        summary.hidden += 1;
        if (result.status === 'pending') summary.pending += 1;
        else if (result.status === 'error') summary.errors += 1;
    }
    return { items, summary };
}

async function getMatch(db, source, externalId) {
    const sourceId = await sourceIdOf(db, source);
    const row = await readRow(db, sourceId, String(externalId));
    return row ? matchFromRow(source, row) : null;
}

async function setOverride(db, { source, externalId, videoId, userId = null, isrc = null }) {
    if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId)) throw badRequest('videoId must be an 11-character YouTube id');
    const sourceId = await sourceIdOf(db, source);
    await db.run(
        `INSERT INTO track_matches (source_id, external_id, isrc, status, video_id, score, method, candidates_json, checked_at, override_by, duration_sec)
         VALUES (?, ?, ?, 'matched', ?, NULL, 'manual', NULL, ?, ?, NULL)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
             isrc = COALESCE(excluded.isrc, track_matches.isrc),
             status = 'matched',
             video_id = excluded.video_id,
             score = NULL,
             method = 'manual',
             checked_at = excluded.checked_at,
             override_by = excluded.override_by,
             duration_sec = NULL`,
        [sourceId, String(externalId), isrc || null, videoId, Date.now(), userId]
    );
}

async function markUnavailable(db, { source, externalId, userId = null }) {
    const sourceId = await sourceIdOf(db, source);
    await db.run(
        `INSERT INTO track_matches (source_id, external_id, status, video_id, score, method, checked_at, override_by, duration_sec)
         VALUES (?, ?, 'not_found', NULL, NULL, 'manual', ?, ?, NULL)
         ON CONFLICT(source_id, external_id) DO UPDATE SET
             status = 'not_found',
             video_id = NULL,
             score = NULL,
             method = 'manual',
             checked_at = excluded.checked_at,
             override_by = excluded.override_by,
             duration_sec = NULL`,
        [sourceId, String(externalId), Date.now(), userId]
    );
}

async function report(db, { source, externalId, userId = null, reason, videoId = null, note = null }) {
    if (!REPORT_REASONS.has(reason)) throw badRequest('reason must be wrong_match, unavailable or other');
    if (videoId !== null && videoId !== undefined && (typeof videoId !== 'string' || !VIDEO_ID.test(videoId))) {
        throw badRequest('videoId must be an 11-character YouTube id');
    }
    const sourceId = await sourceIdOf(db, source);
    await db.run(
        `INSERT INTO match_reports (user_id, source_id, external_id, reason, video_id, note) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, sourceId, String(externalId), reason, videoId || null, note || null]
    );
    // The report doubles as the correction when the user supplied one.
    if (videoId) await setOverride(db, { source, externalId, videoId, userId });
    if (reason === 'unavailable') await markUnavailable(db, { source, externalId, userId });
}

// Drops the stored decision so the next read resolves again. resolve() treats
// a `matched` row as final and reuses `not_found` for 30 days, so this is the
// only way short of `force` to make it look again. The next resolution also
// skips the ISRC shortcut once, otherwise it would copy back the sibling's
// (possibly wrong) answer without a search.
async function forget(db, source, externalId) {
    const sourceId = await sourceIdOf(db, source);
    const id = String(externalId);
    await db.run('DELETE FROM track_matches WHERE source_id = ? AND external_id = ?', [sourceId, id]);
    const key = keyOf({ source, id });
    inFlight.delete(key);
    forgotten.add(key);
}

function resetForTests() {
    inFlight.clear();
    forgotten.clear();
    sourceIds.clear();
    warnedSources.clear();
    innertubeBlockedUntil = 0;
    innertubeQueue.reset();
    ytsearchQueue.reset();
}

module.exports = {
    resolve,
    resolveMany,
    filterPlayable,
    getMatch,
    setOverride,
    markUnavailable,
    report,
    forget,
    isMatchSource,
    matchSources,
    keyOf,
    _internals: {
        queue: innertubeQueue,
        ytsearchQueue,
        inFlight,
        forgotten,
        sourceIds,
        isFresh,
        createQueue,
        blockedUntil: () => innertubeBlockedUntil,
        resetForTests
    }
};
