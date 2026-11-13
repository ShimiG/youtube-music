// The match engine's decision log: one JSON line per track it had to decide,
// with everything the decision was made from.
//   <data folder>/logs/matches.jsonl      the current log
//   <data folder>/logs/matches.jsonl.1    the one before it (rotated at 5 MB)
//
// server.log says that something happened; this says why. A line holds the
// track as the engine received it, every search that ran (the query, how long
// it took, what came back) and the verdict on each candidate, which is enough
// to replay the decision without the network. evals/matcher/from-journal.js
// turns these lines into eval cases, so a wrong match seen in real use becomes
// a test.
//
// Only fresh decisions are written (a cached answer is counted by
// services/usage.js, not logged), so the volume is one line per track, once.
// Lines hold titles, artist names and video ids, never tokens or URLs, and the
// file stays on this computer. MATCH_LOG=off disables it.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../paths');

const FILE_NAME = 'matches.jsonl';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
const OFF = /^(?:0|false|off|no)$/i;
const ON = /^(?:1|true|on|yes)$/i;

let size = null; // bytes in the current file; null until first looked at

const logDir = () => path.join(dataDir(), 'logs');
const logPath = () => path.join(logDir(), FILE_NAME);

// On by default, except under the test runner, where nothing should write
// into the project folder unless a test asks for it.
function enabled() {
    const raw = String(process.env.MATCH_LOG || '').trim();
    if (OFF.test(raw)) return false;
    if (ON.test(raw)) return true;
    return process.env.NODE_ENV !== 'test';
}

function append(line) {
    try {
        if (size === null) {
            fs.mkdirSync(logDir(), { recursive: true });
            size = fs.existsSync(logPath()) ? fs.statSync(logPath()).size : 0;
        }
        const bytes = Buffer.byteLength(line);
        if (size + bytes > MAX_BYTES) {
            fs.renameSync(logPath(), `${logPath()}.1`);
            size = 0;
        }
        fs.appendFileSync(logPath(), line, { mode: 0o600 });
        size += bytes;
    } catch {
        // A log that cannot be written must never fail a match.
        size = null;
    }
}

// What a search returned, without the fields only the scorer adds.
function compactCandidate(c) {
    const out = { videoId: c.videoId, title: c.title, artists: c.artists, durationSec: c.durationSec };
    if (c.album) out.album = c.album;
    if (c.plays) out.plays = c.plays;
    if (c.videoType) out.videoType = c.videoType;
    if (c.origin === 'ytsearch') {
        out.origin = 'ytsearch';
        out.channel = c.channel;
        out.channelIsVerified = c.channelIsVerified === true;
        if (c.liveStatus) out.liveStatus = c.liveStatus;
    }
    return out;
}

function compactStep(step) {
    const out = { kind: step.kind, q: step.q, ms: step.ms || 0 };
    if (step.error) out.error = step.error;
    else out.results = (step.results || []).map(compactCandidate);
    return out;
}

/**
 * Builds the log entry for one decision.
 * @param {object} track    the bounded track the engine searched for
 * @param {object} outcome  { status, videoId, score, method, candidates }
 * @param {object} trace    { ms, steps: [{ kind, q, ms, results | error }], evaluated: [scored candidates] }
 */
function entryOf(track, outcome, trace = {}) {
    const steps = Array.isArray(trace.steps) ? trace.steps : [];
    const sent = steps.filter((s) => s.sent);
    return {
        ts: new Date().toISOString(),
        key: `${track.source}:${track.id}`,
        track: {
            title: track.title || '',
            artist: track.artist || null,
            ...(Array.isArray(track.artists) && track.artists.length ? { artists: track.artists } : {}),
            ...(track.album ? { album: track.album } : {}),
            durationSec: track.durationSec ?? null,
            ...(track.isrc ? { isrc: String(track.isrc) } : {})
        },
        status: outcome.status,
        videoId: outcome.videoId || null,
        score: outcome.score ?? null,
        method: outcome.method || null,
        ms: trace.ms || 0,
        // What the decision cost: searches actually sent upstream.
        cost: {
            innertube: sent.filter((s) => s.kind !== 'ytsearch').length,
            ytdlp: sent.filter((s) => s.kind === 'ytsearch').length
        },
        steps: steps.map(compactStep),
        // The scorer's verdict on every candidate, in rank order.
        verdicts: (Array.isArray(trace.evaluated) && trace.evaluated.length ? trace.evaluated : (outcome.candidates || [])).map((c) => ({
            videoId: c.videoId,
            ok: c.ok === true,
            score: c.score ?? null,
            ...(c.reasons && c.reasons.length ? { reasons: c.reasons } : {})
        }))
    };
}

// Where entries go. A function here receives every entry instead of the file
// (the eval runner collects them; tests assert on them).
const hooks = { sink: null };

function write(entry) {
    try {
        if (typeof hooks.sink === 'function') {
            hooks.sink(entry);
            return;
        }
        if (!enabled()) return;
        let line = `${JSON.stringify(entry)}\n`;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
            // Hundreds of candidates: keep the decision, drop what it was made from.
            line = `${JSON.stringify({ ...entry, steps: entry.steps.map(({ results, ...rest }) => ({ ...rest, dropped: (results || []).length })) })}\n`;
        }
        append(line);
    } catch {
        // Same rule as append(): logging is never the reason a match fails.
    }
}

/** Logs one decision; does nothing (and builds nothing) when logging is off. */
function record(track, outcome, trace) {
    if (typeof hooks.sink !== 'function' && !enabled()) return;
    try {
        write(entryOf(track, outcome, trace));
    } catch {
        // See append().
    }
}

/** The last `maxEntries` decisions, oldest first (previous file, then current). */
function readRecent(maxEntries = 100) {
    const wanted = Math.max(1, Math.min(1000, Number(maxEntries) || 100));
    const tail = (file) => {
        try {
            const stat = fs.statSync(file);
            const start = Math.max(0, stat.size - TAIL_BYTES);
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(stat.size - start);
                fs.readSync(fd, buf, 0, buf.length, start);
                const lines = buf.toString('utf8').split('\n');
                if (start > 0) lines.shift(); // a cut first line
                return lines.filter(Boolean);
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return [];
        }
    };
    let lines = tail(logPath());
    if (lines.length < wanted) lines = [...tail(`${logPath()}.1`), ...lines];
    const entries = [];
    for (const line of lines.slice(-wanted)) {
        try { entries.push(JSON.parse(line)); } catch { /* a torn line */ }
    }
    return entries;
}

// Tests only.
function _resetForTests() {
    size = null;
    hooks.sink = null;
}

module.exports = { record, write, entryOf, readRecent, enabled, hooks, FILE_NAME, MAX_BYTES, _resetForTests };
