// Reads tags and duration from a local audio file (issue #24), through
// music-metadata. The library is ESM-only: Node >= 22.12 can require() it
// (and esbuild bundles it with the `module-sync` condition), but Jest cannot
// load it, so it is required lazily behind `runner`, which tests replace.
const runner = {
    parse: (filePath) => require('music-metadata').parseFile(filePath, { duration: true, skipCovers: true })
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

module.exports = { readTags, runner };
