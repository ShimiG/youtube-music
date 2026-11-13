// Robustness suite: the same question asked many ways.
//
// The labelled cases (cases/*.json) check situations somebody thought of. This
// suite checks ones nobody wrote down. It takes every (track, right video)
// pair it can find, the real catalog entries in the recorded responses and
// the right answers of the labelled cases, and rewrites the track mechanically:
//
//   invariant rewrites   must still match the same video: a remaster tag,
//                        upper case, a missing accent, 3 s of drift ...
//   sensitive rewrites   must stop matching it: "(Live)", a remix, another
//                        artist, another title, 6 s of drift ...
//
// Each rewritten track is run through the real engine against that one video.
// The expected answer follows from the rewrite, not from a person's judgement
// of the case, so a failure here is a rule that does not hold on some real
// title shape.
const fs = require('fs');
const path = require('path');

const innertube = require('../../services/matcher/innertube');
const initDB = require('../../config/db');
const { runCase } = require('./lib');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const RECORDED = [
    ['innertube-search.json', 'songs'],
    ['innertube-songs-khruangbin.json', 'songs'],
    ['innertube-videos.json', 'videos']
];

const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
const stripMarks = (s) => String(s).normalize('NFKD').replace(/\p{M}+/gu, '');
const mapNames = (track, fn) => ({
    ...track,
    artist: track.artist ? fn(track.artist) : track.artist,
    ...(Array.isArray(track.artists) ? { artists: track.artists.map(fn) } : {})
});
const retitle = (fn) => (track) => ({ ...track, title: fn(track.title) });
const drift = (sec) => (track) => (track.durationSec > 0 ? { ...track, durationSec: Math.max(1, track.durationSec + sec) } : null);
// A rewrite that changes nothing says nothing: it is skipped for that pair.
const ifChanged = (fn) => (track) => {
    const next = fn(track);
    return next && JSON.stringify(next) !== JSON.stringify(track) ? next : null;
};
const unless = (pattern, fn) => (track) => (pattern.test(track.title) ? null : fn(track));

// Rewrites after which the track is still the same recording.
const INVARIANT = {
    'remaster "- Remastered 2011"': retitle((t) => `${t} - Remastered 2011`),
    'remaster "(2011 Remaster)"': retitle((t) => `${t} (2011 Remaster)`),
    'noise "(Album Version)"': retitle((t) => `${t} (Album Version)`),
    'noise "[Explicit]"': retitle((t) => `${t} [Explicit]`),
    'noise "(Deluxe Edition)"': retitle((t) => `${t} (Deluxe Edition)`),
    'film credit "(From ...)"': retitle((t) => `${t} (From "The Motion Picture")`),
    'round brackets as square': ifChanged(retitle((t) => t.replace(/\(/g, '[').replace(/\)/g, ']'))),
    'doubled spaces': ifChanged(retitle((t) => t.replace(/ /g, '  '))),
    'title in upper case': ifChanged(retitle((t) => t.toUpperCase())),
    'artist in lower case': ifChanged((track) => mapNames(track, (name) => name.toLowerCase())),
    'accents removed': ifChanged((track) => mapNames({ ...track, title: stripMarks(track.title) }, stripMarks)),
    'typographic apostrophes': ifChanged((track) => mapNames({ ...track, title: track.title.replace(/'/g, '’') }, (name) => name.replace(/'/g, '’'))),
    '"&" and "and" swapped': ifChanged(retitle((t) => (/ & /.test(t) ? t.replace(/ & /g, ' and ') : t.replace(/ and /g, ' & ')))),
    'album unknown': ifChanged((track) => without(track, 'album')),
    'guests moved into the title': (track) => {
        if (!Array.isArray(track.artists) || track.artists.length < 2 || /\b(feat|ft|featuring|with)\b/i.test(track.title)) return null;
        return { ...track, title: `${track.title} (feat. ${track.artists.slice(1).join(' & ')})` };
    },
    'artists as one "A & B" string': (track) => {
        if (!Array.isArray(track.artists) || track.artists.length < 2) return null;
        const { artists, ...rest } = track;
        return { ...rest, artist: artists.join(' & ') };
    },
    '3 s longer': drift(3),
    '3 s shorter': drift(-3),
    '5 s longer (at the tolerance)': drift(5)
};

// Rewrites after which the track is a different recording, or another song.
const SENSITIVE = {
    'tagged "(Live)"': unless(/\blive\b/i, retitle((t) => `${t} (Live)`)),
    'tagged "- Acoustic"': unless(/acoustic/i, retitle((t) => `${t} - Acoustic`)),
    'tagged "(Instrumental)"': unless(/instrumental/i, retitle((t) => `${t} (Instrumental)`)),
    'tagged "(Sped Up)"': unless(/sped.?up/i, retitle((t) => `${t} (Sped Up)`)),
    'tagged "(Radio Edit)"': unless(/radio (edit|version|mix)/i, retitle((t) => `${t} (Radio Edit)`)),
    'tagged "(Karaoke Version)"': unless(/karaoke/i, retitle((t) => `${t} (Karaoke Version)`)),
    'tagged "(Demo)"': unless(/\bdemo\b/i, retitle((t) => `${t} (Demo)`)),
    'tagged "(Mono)"': unless(/\bmono\b/i, retitle((t) => `${t} (Mono)`)),
    'tagged "- Live at Wembley Stadium"': unless(/\blive\b/i, retitle((t) => `${t} - Live at Wembley Stadium`)),
    'a named remix': retitle((t) => `${t} (Night Shift Remix)`),
    'another artist': (track) => ({ ...track, artist: 'The Wrong Band', artists: ['The Wrong Band'] }),
    'another title': retitle((t) => `Another ${t}`),
    '6 s longer (past the tolerance)': drift(6),
    '6 s shorter (past the tolerance)': drift(-6),
    '30 s longer': drift(30)
};

// --- Pairs ----------------------------------------------------------------------

/** Every official entry in the recorded responses, as its own track. */
function recordedPairs() {
    const pairs = [];
    const seen = new Set();
    for (const [file, kind] of RECORDED) {
        const parsed = innertube.parseResults(JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')));
        for (const c of parsed) {
            if ((c.videoType !== 'atv' && c.videoType !== 'omv') || seen.has(c.videoId) || !c.artists.length) continue;
            seen.add(c.videoId);
            pairs.push({
                id: `real-${c.videoId}`,
                origin: 'recorded',
                kind,
                track: { title: c.title, artist: c.artists[0], artists: c.artists, ...(c.album ? { album: c.album } : {}), durationSec: c.durationSec || 0 },
                candidate: { label: c.videoId, videoId: c.videoId, title: c.title, artists: c.artists, dur: c.durationSec, type: c.videoType, ...(c.album ? { album: c.album } : {}), ...(c.plays ? { plays: c.plays } : {}) }
            });
        }
    }
    return pairs;
}

function findCandidate(item, label) {
    for (const kind of ['songs', 'videos']) {
        const spec = item[kind];
        const lists = Array.isArray(spec) ? [spec] : (spec && Array.isArray(spec.calls) ? spec.calls : []);
        for (const list of lists) {
            const found = list.find((c) => c.label === label);
            if (found) return { kind, candidate: found };
        }
    }
    return null;
}

/** The right answer of every labelled case the engine got right by searching. */
function labelledPairs(cases, results) {
    const byId = new Map(results.map((r) => [r.id, r]));
    const pairs = [];
    for (const item of cases) {
        const result = byId.get(item.id);
        if (!result || result.outcome !== 'correct_match' || item.innertube || item.seed || item.env) continue;
        const found = findCandidate(item, result.picked);
        if (!found) continue;
        const track = without(item.track, 'isrc', 'source');
        pairs.push({
            id: item.id,
            origin: 'constructed',
            kind: found.kind,
            // The pair starts with equal lengths so every drift is exact.
            track: { ...track, durationSec: found.candidate.dur || track.durationSec || 0 },
            candidate: found.candidate
        });
    }
    return pairs;
}

const caseOf = (pair, name, track, accept) => ({
    id: `${pair.id} / ${name}`,
    track,
    songs: pair.kind === 'songs' ? [pair.candidate] : [],
    videos: pair.kind === 'videos' ? [pair.candidate] : [],
    accept
});

// --- Running --------------------------------------------------------------------

async function runOne(item) {
    const db = await initDB(':memory:');
    try {
        return await runCase(db, item);
    } finally {
        await db.close();
    }
}

/**
 * Runs the suite. Returns
 * { pairs, basePassed, baseFailed: [id], checks, passed, rewrites: { name: { kind, checks, passed } }, failures: [{ id, kind, outcome, reasons }] }.
 */
async function runRobustness(cases, results) {
    const savedLog = console.log;
    console.log = () => {};
    try {
        const pairs = [...recordedPairs(), ...labelledPairs(cases, results)];
        const rewrites = {};
        const failures = [];
        const baseFailed = [];
        let checks = 0;
        let passed = 0;

        for (const pair of pairs) {
            const label = pair.candidate.label;
            // A pair that does not match as it stands has nothing to be robust about.
            const base = await runOne(caseOf(pair, 'unchanged', pair.track, [label]));
            if (!base.pass) {
                baseFailed.push(pair.id);
                failures.push({ id: base.id, kind: 'base', outcome: base.outcome, reasons: base.reasons[label] || [] });
                continue;
            }
            for (const [kind, table] of [['invariant', INVARIANT], ['sensitive', SENSITIVE]]) {
                for (const [name, rewrite] of Object.entries(table)) {
                    const track = rewrite(pair.track);
                    if (!track) continue;
                    const result = await runOne(caseOf(pair, name, track, kind === 'invariant' ? [label] : []));
                    const tally = rewrites[name] = rewrites[name] || { kind, checks: 0, passed: 0 };
                    tally.checks += 1;
                    checks += 1;
                    if (result.pass) {
                        tally.passed += 1;
                        passed += 1;
                    } else {
                        failures.push({ id: result.id, kind, outcome: result.outcome, reasons: result.reasons[label] || [] });
                    }
                }
            }
        }

        const origins = {};
        for (const pair of pairs) origins[pair.origin] = (origins[pair.origin] || 0) + 1;
        return { pairs: pairs.length, pairOrigins: origins, basePassed: pairs.length - baseFailed.length, baseFailed, checks, passed, rewrites, failures };
    } finally {
        console.log = savedLog;
    }
}

module.exports = { runRobustness, recordedPairs, labelledPairs, INVARIANT, SENSITIVE };
