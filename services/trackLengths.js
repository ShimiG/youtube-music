// How long each track is, remembered across restarts
// (docs/performance-plan.md, step 1.2).
//
// The player needs a track's length to draw the seek bar. Where a list does
// not carry it (a YouTube playlist, Recently Played, a custom playlist) the
// client asks /duration, and the only way to find out was yt-dlp: one to
// three seconds of work for a number the app had usually seen before, even
// when the audio itself came straight from the disk cache. Lengths were only
// kept in memory, so every restart forgot them.
//
// Here they are kept in the database (track_lengths) as they are learned:
// from a yt-dlp look-up, from the services' own track lists, from the
// YouTube API. Lists are completed from it before they are sent, so the
// client seldom has to ask at all.
//
// Only for sources whose track always plays at its catalogue length. Deezer
// is left out: what plays there may be a 30-second preview.
const SOURCES = new Set(['youtube', 'soundcloud']);
const MAX_SECONDS = 24 * 60 * 60;
const MEMORY_MAX = 5000;
const KEEP_ROWS = 50000;      // the table is trimmed to this many, newest first
const QUERY_CHUNK = 200;      // ids per query, well under SQLite's parameter limit

const memory = new Map(); // "<source>\n<id>" -> seconds
let database = null;

const keyOf = (source, id) => `${source}\n${id}`;
const usable = (source, id, seconds) => SOURCES.has(source)
    && typeof id === 'string' && id.length > 0 && id.length <= 200
    && Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_SECONDS;

function keepInMemory(source, id, seconds) {
    const key = keyOf(source, id);
    memory.delete(key); // re-inserted at the end: the oldest entry is the first
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
    memory.set(key, seconds);
}

/** The database lengths are kept in. Without one (tests), memory only. */
function use(db) {
    database = db || null;
}

const UPSERT = `INSERT INTO track_lengths (source, external_id, duration_sec, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(source, external_id) DO UPDATE SET duration_sec = excluded.duration_sec, updated_at = excluded.updated_at`;

/** Notes one length. Never throws and never makes its caller wait. */
function remember(source, id, seconds) {
    const rounded = Math.round(Number(seconds));
    const externalId = id === undefined || id === null ? '' : String(id);
    if (!usable(source, externalId, rounded)) return;
    const key = keyOf(source, externalId);
    const same = memory.get(key) === rounded;
    keepInMemory(source, externalId, rounded);
    if (same || !database) return; // already written with this value
    database.run(UPSERT, [source, externalId, rounded, Date.now()])
        .catch((err) => console.warn(`Track lengths: could not save ${source} ${externalId}: ${err.message}`));
}

/** What is known without asking the database: seconds, or null. */
function peek(source, id) {
    return memory.get(keyOf(source, String(id))) || null;
}

/** Whether lengths outlive this process (a database is in use). */
const persistent = () => Boolean(database);

/** The length of one track in seconds, or null when it has never been seen. */
async function known(source, id) {
    const externalId = String(id);
    const key = keyOf(source, externalId);
    if (memory.has(key)) return memory.get(key);
    if (!database || !SOURCES.has(source)) return null;
    try {
        const row = await database.get('SELECT duration_sec FROM track_lengths WHERE source = ? AND external_id = ?', [source, externalId]);
        if (!row) return null;
        keepInMemory(source, externalId, row.duration_sec);
        return row.duration_sec;
    } catch (err) {
        console.warn(`Track lengths: could not read ${source} ${externalId}: ${err.message}`);
        return null;
    }
}

/** Lengths of several tracks of one source: Map of id -> seconds, for those that are known. */
async function knownMany(source, ids) {
    const found = new Map();
    if (!SOURCES.has(source)) return found;
    const missing = [];
    for (const id of new Set(ids.map(String))) {
        const key = keyOf(source, id);
        if (memory.has(key)) found.set(id, memory.get(key));
        else missing.push(id);
    }
    if (!database || missing.length === 0) return found;
    try {
        for (let i = 0; i < missing.length; i += QUERY_CHUNK) {
            const chunk = missing.slice(i, i + QUERY_CHUNK);
            const rows = await database.all(
                `SELECT external_id, duration_sec FROM track_lengths WHERE source = ? AND external_id IN (${chunk.map(() => '?').join(',')})`,
                [source, ...chunk]
            );
            for (const row of rows) {
                found.set(row.external_id, row.duration_sec);
                keepInMemory(source, row.external_id, row.duration_sec);
            }
        }
    } catch (err) {
        console.warn(`Track lengths: could not read ${source}: ${err.message}`);
    }
    return found;
}

/**
 * Brings a list of tracks ({ source, id, durationSec, ... }) up to date in
 * both directions: lengths the list carries are remembered, and tracks
 * without one get it from what is remembered. The tracks are changed in
 * place; the list is returned. `lengthKey` names the field (the track lists
 * use durationSec). Never throws.
 */
async function complete(tracks, { lengthKey = 'durationSec' } = {}) {
    if (!Array.isArray(tracks) || tracks.length === 0) return tracks;
    const learned = [];
    const wanted = new Map(); // source -> tracks without a length
    for (const track of tracks) {
        if (!track || !SOURCES.has(track.source) || track.id === null || track.id === undefined) continue;
        // A snippet (SoundCloud Go+) or a track whose length is decided at
        // play time says nothing about the full track.
        if (track.preview || track.verifyDuration) continue;
        const seconds = Math.round(Number(track[lengthKey]));
        if (usable(track.source, String(track.id), seconds)) {
            if (memory.get(keyOf(track.source, String(track.id))) !== seconds) learned.push([track.source, String(track.id), seconds]);
        } else {
            if (!wanted.has(track.source)) wanted.set(track.source, []);
            wanted.get(track.source).push(track);
        }
    }
    for (const [source, list] of wanted) {
        const lengths = await knownMany(source, list.map((track) => track.id));
        for (const track of list) {
            const seconds = lengths.get(String(track.id));
            if (seconds) track[lengthKey] = seconds;
        }
    }
    if (learned.length) {
        for (const [source, id, seconds] of learned) keepInMemory(source, id, seconds);
        if (database) {
            const now = Date.now();
            // One transaction for the page, and not awaited: the list does not wait for it.
            database.transaction(async () => {
                for (const [source, id, seconds] of learned) await database.run(UPSERT, [source, id, seconds, now]);
            }).catch((err) => console.warn(`Track lengths: could not save a page: ${err.message}`));
        }
    }
    return tracks;
}

/** Keeps the table from growing without end. Run once, some time after start-up. */
async function trim() {
    if (!database) return 0;
    const result = await database.run(
        `DELETE FROM track_lengths WHERE rowid IN (
             SELECT rowid FROM track_lengths ORDER BY updated_at DESC LIMIT -1 OFFSET ?
         )`,
        [KEEP_ROWS]
    );
    return result.changes;
}

// Tests only.
function _reset() {
    memory.clear();
    database = null;
}

module.exports = { use, remember, peek, persistent, known, knownMany, complete, trim, SOURCES, KEEP_ROWS, _reset };
