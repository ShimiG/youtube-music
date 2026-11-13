#!/usr/bin/env node
// Turns the match engine's decision log into eval cases.
//
// Every line of logs/matches.jsonl (services/matcher/journal.js) holds a track
// and everything the searches returned for it, so it can be replayed as a
// case. What a line does not hold is whether the engine was right. That comes
// from the people using the app: a "Wrong match?" correction or an
// "unavailable" report is stored in the database, and with --db this script
// reads those and writes them into the cases as the right answer.
//
//   node evals/matcher/from-journal.js --db <data folder>/database.sqlite > evals/matcher/cases/reported.json
//       only decisions a person corrected, labelled with the correction
//   node evals/matcher/from-journal.js --all
//       every logged decision; uncorrected ones are tagged "unreviewed" and
//       labelled with the engine's own answer (a snapshot to review by hand,
//       not evidence the engine was right)
//
//   --log <file>   the log to read (default: logs/matches.jsonl in the data folder)
//
// The database is opened read-only. Titles and artist names from the user's
// library end up in the output: look before committing it.
const fs = require('fs');

const ERROR_MODES = { RATE_LIMITED: 'rate_limited', UNAVAILABLE: 'down', UPSTREAM: 'http500' };

const candidateOf = (c) => ({
    label: c.videoId,
    videoId: c.videoId,
    title: c.title,
    artists: c.artists || [],
    dur: c.durationSec ?? null,
    ...(c.album ? { album: c.album } : {}),
    ...(c.plays ? { plays: c.plays } : {}),
    ...(c.videoType ? { type: c.videoType } : {})
});

const ytEntryOf = (c) => ({
    label: c.videoId,
    id: c.videoId,
    title: c.title,
    channel: c.channel ?? null,
    dur: c.durationSec ?? null,
    ...(c.channelIsVerified ? { verified: true } : {}),
    ...(c.plays ? { views: c.plays } : {}),
    ...(c.liveStatus ? { live: c.liveStatus } : {})
});

/**
 * One log entry as an eval case. `correction` is what a person said the right
 * answer is: { videoId } or { unavailable: true }; without it the engine's own
 * answer is used and the case is tagged "unreviewed".
 */
function caseOf(entry, correction = null) {
    const [source, ...rest] = String(entry.key).split(':');
    const item = {
        id: `journal-${entry.key}-${entry.ts}`.replace(/[^A-Za-z0-9:._-]/g, '_'),
        tags: ['journal', correction ? 'reported' : 'unreviewed'],
        origin: 'journal',
        why: correction
            ? `Logged ${entry.ts}: the engine answered ${entry.videoId || entry.status}; a person corrected it to ${correction.unavailable ? 'not available' : correction.videoId}.`
            : `Logged ${entry.ts}: the engine answered ${entry.videoId || entry.status}. Not reviewed by a person.`,
        track: { source, ...entry.track, externalId: rest.join(':') }
    };
    const songs = {};
    const videos = {};
    for (const step of entry.steps || []) {
        if (step.error) {
            // The first failure decides how the replay behaves from then on.
            if (step.kind !== 'ytsearch' && !item.innertube) item.innertube = ERROR_MODES[step.error] || 'down';
            continue;
        }
        if (step.kind === 'songs') songs[step.q] = (step.results || []).map(candidateOf);
        else if (step.kind === 'videos') videos[step.q] = (step.results || []).map(candidateOf);
        else if (step.kind === 'ytsearch') item.ytsearch = (step.results || []).map(ytEntryOf);
    }
    if (Object.keys(songs).length) item.songs = { queries: songs };
    if (Object.keys(videos).length) item.videos = { queries: videos };

    if (correction) {
        item.accept = correction.unavailable ? [] : [correction.videoId];
    } else {
        item.accept = entry.videoId ? [entry.videoId] : [];
        if (entry.status === 'error') item.expectStatus = 'error';
    }
    return item;
}

/**
 * Cases for the logged decisions. `corrections` maps "source:id" to
 * { videoId } | { unavailable: true }. When a track was decided more than once
 * the latest decision is the one kept.
 */
function casesFromEntries(entries, corrections = new Map(), { all = false } = {}) {
    const latest = new Map();
    for (const entry of entries) {
        if (entry && entry.key && entry.track) latest.set(entry.key, entry);
    }
    const cases = [];
    for (const [key, entry] of latest) {
        const correction = corrections.get(key) || null;
        if (correction || all) cases.push(caseOf(entry, correction));
    }
    return cases;
}

/** What people decided, read from the app's database: source:id -> correction. */
function readCorrections(dbFile) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
        const corrections = new Map();
        const rows = db.prepare(
            `SELECT s.name AS source, m.external_id AS id, m.status, m.video_id AS videoId
             FROM track_matches m JOIN sources s ON s.id = m.source_id
             WHERE m.override_by IS NOT NULL OR m.method = 'manual'`
        ).all();
        for (const row of rows) {
            if (row.status === 'matched' && row.videoId) corrections.set(`${row.source}:${row.id}`, { videoId: row.videoId });
            else if (row.status === 'not_found') corrections.set(`${row.source}:${row.id}`, { unavailable: true });
        }
        return corrections;
    } finally {
        db.close();
    }
}

function readEntries(file) {
    const entries = [];
    for (const name of [`${file}.1`, file]) {
        let text;
        try { text = fs.readFileSync(name, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try { entries.push(JSON.parse(line)); } catch { /* a torn line */ }
        }
    }
    return entries;
}

function main() {
    const args = process.argv.slice(2);
    const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
    const path = require('path');
    const logFile = valueOf('--log') || path.join(require('../../services/paths').dataDir(), 'logs', 'matches.jsonl');
    const dbFile = valueOf('--db');
    const all = args.includes('--all');
    if (!dbFile && !all) {
        console.error('Nothing to do: pass --db <database.sqlite> for the corrected decisions, or --all for every logged one.');
        process.exitCode = 2;
        return;
    }
    const entries = readEntries(logFile);
    const corrections = dbFile ? readCorrections(dbFile) : new Map();
    const cases = casesFromEntries(entries, corrections, { all });
    process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
    console.error(`${entries.length} logged decisions, ${corrections.size} corrections, ${cases.length} cases written.`);
}

if (require.main === module) main();

module.exports = { caseOf, casesFromEntries, readCorrections, readEntries };
