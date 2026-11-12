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

// Where a track sits in its playlist: when it was added (sort_order, a time in
// milliseconds, set on insert and carried along by cloud sync). Rows from
// before that was recorded have 0 and fall back to their row id, which keeps
// them in the order they were added and ahead of anything added since.
const POSITION = 'CASE WHEN pt.sort_order > 0 THEN pt.sort_order ELSE pt.id END';

// A page continues after a (position, row id) pair: "<position>-<row id>".
function parseTrackCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return null;
    const m = /^(\d{1,16})-(\d{1,16})$/.exec(String(cursor));
    if (!m) throw new SourceError('BAD_CURSOR', 'Invalid cursor.', { source: SOURCE });
    return { position: Number(m[1]), rowId: Number(m[2]) };
}

async function getPlaylistTracks({ db, userId }, playlistId, { cursor } = {}) {
    if (!isRowId(playlistId)) throw new SourceError('NOT_FOUND', 'Playlist not found.', { source: SOURCE });
    const after = parseTrackCursor(cursor);
    await assertOwnership(db, playlistId, userId);

    const rows = await db.all(`
        -- Per-user display metadata (playlist_tracks.title/artist/thumbnail,
        -- security review 2026-11-08): the shared tracks row is only a fallback
        -- for rows added before those columns existed, so one user can't change
        -- what another user's playlists show.
        SELECT pt.id AS rowId, ${POSITION} AS position, t.external_id AS id,
               COALESCE(pt.title, t.title) AS title,
               COALESCE(pt.artist, t.artist) AS artist,
               CASE WHEN pt.title IS NOT NULL THEN pt.thumbnail ELSE t.thumbnail END AS thumbnail,
               s.name AS source
        FROM playlist_tracks pt
        JOIN tracks t ON pt.track_id = t.id
        JOIN sources s ON t.source_id = s.id
        WHERE pt.playlist_id = ?
          AND (? IS NULL OR ${POSITION} > ? OR (${POSITION} = ? AND pt.id > ?))
        ORDER BY ${POSITION} ASC, pt.id ASC
        LIMIT ?
    `, [playlistId, after ? after.position : null, after ? after.position : null, after ? after.position : null, after ? after.rowId : null, PAGE_SIZE + 1]);

    const hasMore = rows.length > PAGE_SIZE;
    const slice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = slice[slice.length - 1];
    return page(slice.map(normalizeTrack), hasMore ? `${last.position}-${last.rowId}` : null);
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
