// Reads tags and duration from a local audio file (issue #24), through
// music-metadata. The library is ESM-only: Node >= 22.12 can require() it
// (and esbuild bundles it with the `module-sync` condition), but Jest cannot
// load it, so it is required lazily behind `runner`, which tests replace.
const runner = {
    parse: (filePath, options = { duration: true }) => require('music-metadata').parseFile(filePath, { skipCovers: true, ...options })
};

const clean = (value, max) => {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text ? text.slice(0, max) : null;
};

/**
 * { title, artist, album, trackNo, durationSec, format } for a file. Missing
 * or unreadable tags give nulls; the caller falls back to the file name.
 */
async function readTags(filePath) {
    const meta = await runner.parse(filePath);
    const common = (meta && meta.common) || {};
    const format = (meta && meta.format) || {};
    const artist = clean(common.artist, 200) || (Array.isArray(common.artists) ? clean(common.artists[0], 200) : null);
    const duration = Number(format.duration);
    const trackNo = common.track && Number.isInteger(common.track.no) ? common.track.no : null;
    return {
        title: clean(common.title, 300),
        artist,
        album: clean(common.album, 300),
        trackNo,
        durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
        format: clean(format.codec || format.container, 40)
    };
}

// ID3 "user text" frames some taggers (and ffmpeg) use for lyrics instead of
// the standard USLT frame, e.g. TXXX:LYRICS or TXXX:lyrics-eng.
const USER_TEXT_LYRICS = /^TXXX:(?:unsynced ?)?lyrics(?:-[a-z]{2,3})?$/i;
const TIMESTAMPS_IN_MS = 2; // music-metadata's TimestampFormat.milliseconds

/**
 * Lyrics stored inside a file's tags (issue #30):
 *   { timed: [{ t (seconds), text }] | null, text: string | null }
 * `timed` is set when the tag carries timestamps (ID3 SYLT, or LRC text in a
 * Vorbis/FLAC LYRICS comment, which music-metadata already splits). `text` is
 * the tag's text as written; it may itself be LRC, which the caller parses.
 */
async function readLyrics(filePath) {
    const meta = await runner.parse(filePath, { duration: false });
    const common = (meta && meta.common) || {};
    const entries = Array.isArray(common.lyrics) ? common.lyrics : [];
    let timed = null;
    let text = null;
    for (const entry of entries) {
        if (typeof entry === 'string') {
            if (!text && entry.trim()) text = entry;
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        if (!timed && entry.timeStampFormat === TIMESTAMPS_IN_MS && Array.isArray(entry.syncText)) {
            const lines = entry.syncText
                .filter((l) => l && Number.isFinite(l.timestamp) && l.timestamp >= 0 && typeof l.text === 'string')
                .map((l) => ({ t: l.timestamp / 1000, text: l.text }));
            if (lines.length) timed = lines;
        }
        if (!text && typeof entry.text === 'string' && entry.text.trim()) text = entry.text;
    }
    if (!timed && !text && meta && meta.native && typeof meta.native === 'object') {
        for (const tags of Object.values(meta.native)) {
            if (!Array.isArray(tags)) continue;
            const hit = tags.find((tag) => tag && USER_TEXT_LYRICS.test(String(tag.id)) && typeof tag.value === 'string' && tag.value.trim());
            if (hit) { text = hit.value; break; }
        }
    }
    return { timed, text };
}

module.exports = { readTags, readLyrics, runner };
