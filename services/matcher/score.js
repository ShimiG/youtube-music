// Decides whether a YouTube candidate is the same recording as a track and,
// when it is, how strongly to prefer it. Pure: the only outside input is the
// duration tolerance env var, read at call time so tests can change it.

const { normalizeText, parseTitle, titlesMatch, normalizeArtist, artistKey, artistMatches, artistsOf } = require('./normalize');

const TOPIC_SUFFIX = /\s-\sTopic$/;
const DEFAULT_TOLERANCE_SEC = 5;

function durationTolerance() {
    const raw = process.env.MATCH_DURATION_TOLERANCE_SEC;
    if (raw === undefined || String(raw).trim() === '') {
        return DEFAULT_TOLERANCE_SEC;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOLERANCE_SEC;
}

// Spotify reports 0 for an unknown duration, so 0 counts as unknown.
function knownDuration(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function isTopicChannel(candidate) {
    return candidate.isTopic === true || (typeof candidate.channel === 'string' && TOPIC_SUFFIX.test(candidate.channel));
}

// Everything about the track that every candidate's evaluation needs: parsed
// once per pickBest instead of once per candidate, with the artist-name
// normalisation memoised because the same few names are compared against
// every candidate's artists.
function prepare(track, opts = {}) {
    const trackArtists = artistsOf(track);
    const keys = new Map();
    const key = (name) => {
        if (!keys.has(name)) keys.set(name, artistKey(name));
        return keys.get(name);
    };
    const same = (a, b) => {
        const x = key(a);
        return x.length > 0 && x === key(b);
    };
    return {
        trackArtists,
        parsedTitle: opts.parsedTrack || parseTitle(track.title, trackArtists),
        same,
        tolerance: Number.isFinite(opts.toleranceSec) ? opts.toleranceSec : durationTolerance()
    };
}

// yt-dlp has no artist field, so the channel stands in: "<Name> - Topic" is
// YouTube's own catalog upload for Name, a verified channel is taken at its
// word, and an unverified channel is a private upload with no artist at all.
function candidateArtists(candidate) {
    if (candidate.origin !== 'ytsearch') {
        return Array.isArray(candidate.artists) ? candidate.artists : [];
    }
    if (typeof candidate.channel !== 'string') {
        return Array.isArray(candidate.artists) ? candidate.artists : [];
    }
    if (isTopicChannel(candidate)) {
        return [candidate.channel.replace(TOPIC_SUFFIX, '').trim()];
    }
    if (candidate.channelIsVerified === true) {
        return [normalizeArtist(candidate.channel)];
    }
    return [];
}

function isOfficial(candidate, ctx) {
    if (candidate.origin === 'ytsearch') {
        if (isTopicChannel(candidate)) {
            return true;
        }
        return candidate.channelIsVerified === true
            && typeof candidate.channel === 'string'
            && ctx.trackArtists.some(a => ctx.same(a, candidate.channel));
    }
    // YouTube Music classifies its own results: ATV and OMV are label
    // deliveries, UGC (and anything unclassified) is a private upload.
    return candidate.videoType === 'atv' || candidate.videoType === 'omv';
}

// Full coverage means every credited track artist appears on the candidate.
// A single unsplit act ("Simon & Garfunkel") counts as covered when the
// candidate lists it as one name. YouTube Music often credits only the primary
// artist of a featured track, so the feats named in the candidate's title
// count here too; they never count for the hard artist check.
function fullCoverage(track, candArtists, ctx) {
    const declared = Array.isArray(track.artists) && track.artists.length ? track.artists : null;
    if (declared) {
        return declared.every(a => candArtists.some(c => ctx.same(a, c)));
    }
    if (typeof track.artist !== 'string' || !track.artist.trim()) {
        return false;
    }
    if (candArtists.some(c => ctx.same(track.artist, c))) {
        return true;
    }
    const pieces = artistsOf({ artist: track.artist }).slice(1);
    return pieces.length > 0 && pieces.every(a => candArtists.some(c => ctx.same(a, c)));
}

function evaluate(track, candidate, opts = {}) {
    const ctx = opts.prepared || prepare(track, opts);
    const reasons = [];
    const candArtists = candidateArtists(candidate);
    const candTitle = parseTitle(candidate.title, ctx.trackArtists);

    if (!isOfficial(candidate, ctx)) {
        reasons.push('unofficial');
    }
    if (!artistMatches(track, candArtists, ctx.same)) {
        reasons.push('artist');
    }
    if (!titlesMatch(ctx.parsedTitle, candTitle)) {
        reasons.push('title');
    }

    const trackDur = knownDuration(track.durationSec);
    const candDur = knownDuration(candidate.durationSec);
    let delta = 0;
    if (trackDur !== null) {
        if (candDur === null) {
            reasons.push('duration');
        } else {
            delta = Math.abs(candDur - trackDur);
            if (delta > ctx.tolerance) {
                reasons.push('duration');
            }
        }
    }

    const liveStatus = candidate.liveStatus !== undefined ? candidate.liveStatus : candidate.live_status;
    if (liveStatus === 'is_live' || liveStatus === 'is_upcoming') {
        reasons.push('live');
    }

    if (reasons.length) {
        return { ok: false, reasons, score: null };
    }

    let score = 90 - 10 * delta;
    if (fullCoverage(track, [...candArtists, ...candTitle.feats], ctx)) {
        score += 10;
    }
    const trackAlbum = normalizeText(track.album);
    const candAlbum = normalizeText(candidate.album);
    if (trackAlbum && candAlbum) {
        score += trackAlbum === candAlbum ? 5 : -5;
    }
    if (typeof track.explicit === 'boolean' && typeof candidate.explicit === 'boolean') {
        score += track.explicit === candidate.explicit ? 3 : -3;
    }
    if (candidate.origin === 'ytsearch') {
        // Channel heuristics are weaker evidence than YouTube Music's own
        // classification, except for the Topic uploads which are the catalog.
        score -= 15;
        if (isTopicChannel(candidate)) {
            score += 5;
        }
    } else if (candidate.videoType === 'omv') {
        // A music video is the same song but not always the same master.
        score -= 10;
    }
    score = Math.round(Math.min(100, Math.max(0, score)));
    return { ok: true, reasons, score };
}

function playsOf(candidate) {
    const n = Number(candidate.plays !== undefined && candidate.plays !== null ? candidate.plays : candidate.viewCount);
    return Number.isFinite(n) ? n : 0;
}

function compareEvaluated(a, b) {
    if (a.ok !== b.ok) {
        return a.ok ? -1 : 1;
    }
    const scoreA = a.score === null ? -1 : a.score;
    const scoreB = b.score === null ? -1 : b.score;
    if (scoreA !== scoreB) {
        return scoreB - scoreA;
    }
    return playsOf(b) - playsOf(a);
}

// Evaluates `candidates` and ranks them together with `evaluated`, entries a
// previous call already scored, so a caller that collects candidates query by
// query only ever evaluates the new ones.
function pickBest(track, candidates = [], { evaluated = [] } = {}) {
    const ctx = prepare(track);
    const fresh = (Array.isArray(candidates) ? candidates : [])
        .filter(c => c && typeof c === 'object')
        .map(c => ({ ...c, ...evaluate(track, c, { prepared: ctx }) }));
    const ranked = [...(Array.isArray(evaluated) ? evaluated : []), ...fresh];
    ranked.sort(compareEvaluated);
    const best = ranked.find(e => e.ok) || null;
    return { best, evaluated: ranked };
}

module.exports = { evaluate, pickBest, prepare, durationTolerance };
