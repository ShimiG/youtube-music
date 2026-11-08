// Validates the display metadata a client sends with a track (history and
// custom playlists). Bounded lengths, and the thumbnail is kept only when it
// is an https URL, because every client renders it as an <img> it loads.
const MAX_TITLE = 300;
const MAX_ARTIST = 200;
const MAX_THUMBNAIL = 2048;

function cleanText(value, max) {
    if (typeof value !== 'string') return null;
    // Drop control characters (log/terminal injection), trim, cap.
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text ? text.slice(0, max) : null;
}

function cleanThumbnail(value) {
    if (typeof value !== 'string' || value.length > MAX_THUMBNAIL) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

/** Returns { title, artist, thumbnail } or null when there is no usable title. */
function cleanTrackMeta({ title, artist, thumbnail } = {}) {
    const cleanTitle = cleanText(title, MAX_TITLE);
    if (!cleanTitle) return null;
    return { title: cleanTitle, artist: cleanText(artist, MAX_ARTIST), thumbnail: cleanThumbnail(thumbnail) };
}

module.exports = { cleanTrackMeta, cleanThumbnail, MAX_TITLE, MAX_ARTIST };
