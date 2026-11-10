// yt-dlp `ytsearch` over YouTube proper: the match engine's fallback source.
//
// It exists for the day the InnerTube client in ./innertube.js breaks: yt-dlp
// is patched within days of any YouTube change and services/ytdlp.js refreshes
// the binary on every start. It is slow (~9 s per flat search) and blind to the
// one field the primary source has, YouTube Music's own official/UGC
// classification. So each candidate carries the channel facts score.js needs
// for the channel-name rule instead: a "<Artist> - Topic" channel is the
// auto-generated catalog upload; a verified channel named like the artist is
// the artist's own; anything else is a private upload. "Verified" alone proves
// nothing (the lyric channel 7clouds is verified), which is why an unverified
// channel yields no artist at all and a verified one yields a name for score.js
// to compare rather than a verdict.
//
// Process spawning goes through `runner.exec` so tests can stub it.
const { execFile } = require('child_process');
const { ytDlpPath } = require('../ytdlp');
const { MatchSourceError } = require('./innertube');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
// A flat search is ~9 s; a cold yt-dlp start on a slow disk adds a few more.
const EXEC_TIMEOUT_MS = 30 * 1000;
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;

// Never self-update mid-request, keep stderr quiet, one JSON object per entry
// without extracting each video (that would cost ~10 s per result).
const COMMON_ARGS = ['--no-update', '--no-warnings', '--flat-playlist', '-j'];

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// YouTube's auto-generated artist channels: "Daft Punk - Topic".
const TOPIC_SUFFIX = /\s-\sTopic$/;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

// Wrapped so tests can stub process spawning.
const runner = {
    exec: (args) => new Promise((resolve, reject) => {
        execFile(ytDlpPath, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                const detail = (stderr || error.message || '').toString().trim().split('\n').pop();
                const err = new Error(`yt-dlp failed: ${detail}`);
                err.code = 'YTDLP_FAILED';
                err.exitCode = error.code;
                return reject(err);
            }
            resolve(stdout.toString());
        });
    })
};

// --- Configuration ------------------------------------------------------------

/** MATCH_YTDLP_FALLBACK (default on): run yt-dlp when InnerTube *failed*. */
function isEnabled() {
    return !OFF_VALUES.has(String(process.env.MATCH_YTDLP_FALLBACK ?? 'on').trim().toLowerCase());
}

/** MATCH_YTDLP_RECALL (default off): also run it when InnerTube found nothing acceptable. */
function recallEnabled() {
    return ON_VALUES.has(String(process.env.MATCH_YTDLP_RECALL ?? 'false').trim().toLowerCase());
}

// --- Parsing ------------------------------------------------------------------

/** One JSON object per line; blank and malformed lines are skipped. */
function parseJsonLines(stdout) {
    return String(stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        })
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function pickChannel(entry) {
    for (const value of [entry.channel, entry.uploader]) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

// Mirrors the rule score.js applies to ytsearch candidates. The raw channel
// name is kept (not normalised) because artistMatches already compares through
// normalizeArtist, and the raw form is what a person wants to see in a report.
function deriveArtists(channel, { isTopic, channelIsVerified }) {
    if (!channel) return [];
    if (isTopic) return [channel.replace(TOPIC_SUFFIX, '').trim()].filter(Boolean);
    if (channelIsVerified) return [channel];
    return [];
}

/** Maps a flat yt-dlp info dict to a match candidate; null when unusable. */
function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const videoId = typeof entry.id === 'string' && VIDEO_ID.test(entry.id) ? entry.id : null;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!videoId || !title) return null;

    const channel = pickChannel(entry);
    // yt-dlp emits true or null, never false; only an explicit true counts.
    const channelIsVerified = entry.channel_is_verified === true;
    const isTopic = channel !== null && TOPIC_SUFFIX.test(channel);
    const duration = Number(entry.duration);
    const views = Number(entry.view_count);

    return {
        videoId,
        title,
        artists: deriveArtists(channel, { isTopic, channelIsVerified }),
        album: null,
        durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        plays: Number.isFinite(views) && views > 0 ? Math.round(views) : 0,
        origin: 'ytsearch',
        channel,
        channelIsVerified,
        isTopic,
        liveStatus: typeof entry.live_status === 'string' ? entry.live_status : null
    };
}

// --- Search -------------------------------------------------------------------

// The query goes to yt-dlp as ONE argv element, never through a shell, so the
// only thing to protect is yt-dlp's own phrase parser: a stray double quote in
// a title would unbalance the phrases, so quotes are removed before embedding.
const cleanPhrase = (value) => String(value ?? '').replace(/"/g, '').replace(/\s+/g, ' ').trim();

function buildSearchArg(artist, title, limit) {
    const phrases = [artist, title].map(cleanPhrase).filter(Boolean).map((phrase) => `"${phrase}"`);
    if (!phrases.length) throw new TypeError('ytsearch needs an artist or a title');
    return `ytsearch${limit}:${phrases.join(' ')}`;
}

/**
 * Flat YouTube search for `"<artist>" "<title>"`. Returns candidates with
 * origin 'ytsearch' plus channel, channelIsVerified, isTopic and liveStatus.
 */
async function searchVideos(artist, title, { limit = DEFAULT_LIMIT } = {}) {
    // Anything that is not a positive count means "the default", never "zero results".
    const requested = Math.trunc(Number(limit));
    const n = Number.isFinite(requested) && requested >= 1 ? Math.min(MAX_LIMIT, requested) : DEFAULT_LIMIT;
    const args = [...COMMON_ARGS, buildSearchArg(artist, title, n)];

    let stdout;
    try {
        stdout = await runner.exec(args);
    } catch (err) {
        if (err instanceof MatchSourceError) throw err;
        const detail = err && err.message ? err.message : String(err);
        throw new MatchSourceError('UNAVAILABLE', `yt-dlp search failed: ${detail}`, { cause: err });
    }
    return parseJsonLines(stdout).map(normalizeEntry).filter(Boolean);
}

module.exports = {
    runner,
    searchVideos,
    normalizeEntry,
    parseJsonLines,
    isEnabled,
    recallEnabled
};
