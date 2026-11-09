// The two shapes every provider emits. Nothing outside a provider should need
// to know how YouTube, SoundCloud or SQLite represent a playlist or a track.
//
//   Playlist { source, id, kind: 'liked' | 'playlist' | 'custom', name,
//              thumbnail, itemCount, readOnly }
//   Track    { source, id, title, artist, album, durationSec, thumbnail,
//              isrc, preview }
//
// Providers may attach extra fields the UI can use (e.g. SoundCloud's
// `playable` and `permalinkUrl`), but the fields above are always present.

const PLAYLIST_KINDS = new Set(['liked', 'playlist', 'custom']);

function makePlaylist({ source, id, kind = 'playlist', name, thumbnail = null, itemCount = null, readOnly = true, ...extra }) {
    return {
        ...extra,
        source,
        id: id === undefined || id === null ? null : String(id),
        kind: PLAYLIST_KINDS.has(kind) ? kind : 'playlist',
        name: name || 'Untitled',
        thumbnail: thumbnail || null,
        itemCount: Number.isFinite(Number(itemCount)) && itemCount !== null ? Number(itemCount) : null,
        readOnly: Boolean(readOnly)
    };
}

function makeTrack({ source, id, title, artist = null, album = null, durationSec = null, thumbnail = null, isrc = null, preview = false, ...extra }) {
    return {
        ...extra,
        source,
        id: id === undefined || id === null ? null : String(id),
        title: title || 'Untitled',
        artist: artist || null,
        album: album || null,
        durationSec: Number.isFinite(Number(durationSec)) && durationSec !== null ? Math.round(Number(durationSec)) : null,
        thumbnail: thumbnail || null,
        isrc: isrc || null,
        preview: Boolean(preview)
    };
}

// The virtual "liked songs" playlist a provider gets when it declares the
// `liked` capability. Its id is the literal string 'liked'; the tracks route
// maps that to the provider's getLikedTracks.
const LIKED_PLAYLIST_ID = 'liked';

function likedPlaylist(source, { name = 'Liked Songs', itemCount = null } = {}) {
    return makePlaylist({ source, id: LIKED_PLAYLIST_ID, kind: 'liked', name, itemCount, readOnly: true });
}

// Every list call returns this. `nextCursor` is opaque to the client: a
// pageToken for YouTube, a next_href for SoundCloud, a row id for SQLite.
function page(items, nextCursor = null) {
    return { items, nextCursor: nextCursor || null };
}

module.exports = { makePlaylist, makeTrack, likedPlaylist, page, LIKED_PLAYLIST_ID };
