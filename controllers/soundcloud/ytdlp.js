// Credential-free SoundCloud provider built on yt-dlp.
//
// Registering an app on the official API needs an Artist Pro subscription, so
// this provider covers the public parts (search, stream resolution, duration)
// without any client id. It is the fallback the controller uses when
// SOUNDCLOUD_CLIENT_ID / SECRET are missing, or when the official API fails.
//
// Caveats, stated plainly: yt-dlp talks to SoundCloud's internal web API with
// a client id it scrapes from the website. That is not covered by the API
// Terms of Use, and it breaks whenever SoundCloud changes its front end, so
// the official client in ./client.js stays the primary path. Go+ tracks come
// back as 30 second snippets (formats suffixed `_preview`).
//
// Ids are the same numeric SoundCloud track ids the official API uses, so a
// track found here plays, caches and logs history exactly like one found via
// the API.
const { execFile } = require('child_process');
const { SOURCE_NAME, isValidId } = require('./client');
const { ytDlpPath } = require('../../services/ytdlp');

const SEARCH_LIMIT = 30;
const EXEC_TIMEOUT_MS = 60 * 1000;
const MAX_STDOUT_BYTES = 20 * 1024 * 1024;

// Flags every call shares: never self-update mid-request, keep stderr quiet.
const COMMON_ARGS = ['--no-update', '--no-warnings', '--no-playlist'];

// yt-dlp's SoundCloud extractor labels snippet renditions with this suffix.
const PREVIEW_FORMAT = /_preview$/;
// Go+ snippets are always exactly 30 s. A flat search result has no formats,
// so this is the only hint available at search time; it is informational.
const PREVIEW_SNIPPET_SECONDS = 30;

// Wrapped so tests can stub process spawning.
const runner = {
    exec: (args) => new Promise((resolve, reject) => {
        execFile(ytDlpPath, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES }, (error, stdout, stderr) => {
            if (error) {
                const err = new Error(`yt-dlp failed: ${(stderr || error.message || '').toString().trim().split('\n').pop()}`);
                err.code = 'YTDLP_FAILED';
                err.exitCode = error.code;
                return reject(err);
            }
            resolve(stdout.toString());
        });
    })
};

const trackUrl = (id) => `https://api.soundcloud.com/tracks/${id}`;

function parseJsonLines(stdout) {
    return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
}

function pickThumbnail(entry) {
    if (Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
        const preferred = entry.thumbnails.find(t => t.id === 't300x300') || entry.thumbnails.find(t => t.id === 'large');
        if (preferred && preferred.url) return preferred.url;
        const last = entry.thumbnails[entry.thumbnails.length - 1];
        if (last && last.url) return last.url;
    }
    return entry.thumbnail || null;
}

/** Maps a yt-dlp info dict (flat or full) to the app's shared Track shape. */
function normalizeEntry(entry) {
    const id = entry && entry.id !== undefined ? String(entry.id) : null;
    if (!isValidId(id)) return null;

    const durationSec = Math.round(Number(entry.duration) || 0);
    const hasFormats = Array.isArray(entry.formats) && entry.formats.length > 0;
    const preview = hasFormats
        ? entry.formats.every(f => PREVIEW_FORMAT.test(f.format_id || ''))
        : durationSec === PREVIEW_SNIPPET_SECONDS;
    const artist = (Array.isArray(entry.artists) && entry.artists[0]) || entry.artist || entry.uploader || 'Unknown Artist';

    return {
        id,
        source: SOURCE_NAME,
        title: entry.title || entry.track || 'Untitled',
        channelTitle: artist,
        artist,
        thumbnail: pickThumbnail(entry),
        duration: durationSec,
        access: preview ? 'preview' : 'playable',
        preview,
        playable: true,
        permalinkUrl: entry.webpage_url || null,
        uploaderUrl: entry.uploader_url || null,
        provider: 'ytdlp'
    };
}

/** Searches SoundCloud. Returns normalised tracks; there is no cursor. */
async function search(query, limit = SEARCH_LIMIT) {
    const n = Math.max(1, Math.min(50, Number(limit) || SEARCH_LIMIT));
    const stdout = await runner.exec([...COMMON_ARGS, '--flat-playlist', '-j', `scsearch${n}:${query}`]);
    return parseJsonLines(stdout).map(normalizeEntry).filter(Boolean);
}

// Prefer an MP3 rendition (progressive `http_mp3` or `hls_mp3`) over SoundCloud's
// AAC fMP4 HLS: ffmpeg decodes the MP3 streams cleanly, whereas the fMP4 AAC
// variant needs an init segment it does not always get and fails to decode. The
// fallback to `bestaudio/best` still covers Go+ tracks, which only offer a
// preview rendition. This mirrors the official API path, which also prefers MP3.
const STREAM_FORMAT = 'bestaudio[ext=mp3]/bestaudio/best';

/** Resolves a direct audio URL (progressive HTTP or HLS) that ffmpeg can read. */
async function resolveStream(id) {
    if (!isValidId(id)) throw new Error('Invalid SoundCloud id');
    // Ask for the format id too, so the caller learns whether this is a snippet.
    const stdout = await runner.exec([...COMMON_ARGS, '-f', STREAM_FORMAT, '--print', 'urls', '--print', 'format_id', trackUrl(id)]);
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    const url = lines.find(l => /^https?:\/\//i.test(l));
    if (!url) {
        const err = new Error('yt-dlp returned no stream URL');
        err.code = 'YTDLP_NO_URL';
        throw err;
    }
    const formatId = lines.find(l => !/^https?:\/\//i.test(l)) || '';
    return { url, isPreview: PREVIEW_FORMAT.test(formatId), format: formatId };
}

/** Track length in whole seconds (a snippet's length for Go+ tracks). */
async function getDuration(id) {
    if (!isValidId(id)) throw new Error('Invalid SoundCloud id');
    const stdout = await runner.exec([...COMMON_ARGS, '--print', 'duration', trackUrl(id)]);
    return Math.round(Number(stdout.trim()) || 0);
}

module.exports = {
    ytDlpPath,
    runner,
    search,
    resolveStream,
    getDuration,
    normalizeEntry,
    parseJsonLines
};
