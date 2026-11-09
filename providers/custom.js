// Local custom playlists as a provider, over the existing SQLite tables, so the
// client has one code path for every source. Read-only through this interface;
// creating playlists and adding tracks stay on the /api/custom-playlists routes.
//
// No token: the user's own session (req.userId) is the only credential.
// Pagination is by row id, passed through as the opaque cursor.
const { SourceError } = require('./errors');
const { makePlaylist, makeTrack, page } = require('./normalize');

const SOURCE = 'custom';
const LABEL = 'Custom Playlists';
const PAGE_SIZE = 50;

const isRowId = (v) => /^\d{1,18}$/.test(String(v));

function parseCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return null;
    if (!isRowId(cursor)) throw new SourceError('BAD_CURSOR', 'Invalid cursor.', { source: SOURCE });
    return Number(cursor);
}

function normalizePlaylist(row) {
    return makePlaylist({
        source: SOURCE,
        id: row.id,
        kind: 'custom',
        name: row.name,
        thumbnail: row.thumbnail,
        itemCount: row.itemCount,
        readOnly: false
    });
}

// A custom playlist row keeps the track's ORIGINAL source (youtube, soundcloud)
// so playback routes to the right provider.
function normalizeTrack(row) {
    return makeTrack({
        source: row.source,
        id: row.id,
        title: row.title,
        artist: row.artist,
        thumbnail: row.thumbnail,
        durationSec: null
    });
}

// Newest first, keyed by id (autoincrement, so id order == creation order).
async function getPlaylists({ db, userId }, { cursor } = {}) {
    const before = parseCursor(cursor);
    const rows = await db.all(`
        SELECT p.id, p.name, p.thumbnail, COUNT(pt.track_id) AS itemCount
        FROM playlists p
        LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
        WHERE p.user_id = ? AND (? IS NULL OR p.id < ?)
        GROUP BY p.id
        ORDER BY p.id DESC
        LIMIT ?
    `, [userId, before, before, PAGE_SIZE + 1]);

    const hasMore = rows.length > PAGE_SIZE;
    const slice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const items = slice.map(normalizePlaylist);
    return page(items, hasMore ? String(slice[slice.length - 1].id) : null);
}

// Confirms the playlist exists AND belongs to the user before any read, so one
// user cannot read another's playlist by guessing its id.
async function assertOwnership(db, playlistId, userId) {
    const row = await db.get(`SELECT id FROM playlists WHERE id = ? AND user_id = ?`, [playlistId, userId]);
    if (!row) throw new SourceError('NOT_FOUND', 'Playlist not found.', { source: SOURCE });
}

async function getPlaylistTracks({ db, userId }, playlistId, { cursor } = {}) {
    if (!isRowId(playlistId)) throw new SourceError('NOT_FOUND', 'Playlist not found.', { source: SOURCE });
    const after = parseCursor(cursor);
    await assertOwnership(db, playlistId, userId);

    // playlist_tracks.sort_order is not populated yet, so insertion order (row
    // id) is the playlist order; that also makes the id a stable cursor.
    const rows = await db.all(`
        SELECT pt.id AS rowId, t.external_id AS id, t.title, t.artist, t.thumbnail, s.name AS source
        FROM playlist_tracks pt
        JOIN tracks t ON pt.track_id = t.id
        JOIN sources s ON t.source_id = s.id
        WHERE pt.playlist_id = ? AND (? IS NULL OR pt.id > ?)
        ORDER BY pt.id ASC
        LIMIT ?
    `, [playlistId, after, after, PAGE_SIZE + 1]);

    const hasMore = rows.length > PAGE_SIZE;
    const slice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return page(slice.map(normalizeTrack), hasMore ? String(slice[slice.length - 1].rowId) : null);
}

module.exports = {
    name: SOURCE,
    label: LABEL,
    sourceId: null,
    connect: { kind: 'none', required: false },
    capabilities: { search: false, playlists: true, liked: false, like: false, stream: false },
    searchRequiresToken: false,
    isAvailable: () => true,
    // no getToken: nothing to connect
    getPlaylists,
    getPlaylistTracks,
    normalizePlaylist,
    normalizeTrack
};
