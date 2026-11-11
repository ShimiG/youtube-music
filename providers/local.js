// Local files provider (issue #24): the user's own folders, scanned into the
// database by services/localLibrary.js. Each folder is a playlist; search
// covers every folder. No account, nothing leaves the computer.
const path = require('path');
const { SourceError } = require('./errors');
const { makePlaylist, makeTrack, page } = require('./normalize');

const SOURCE = 'local';
const LABEL = 'Local Files';
const SOURCE_ID = 6; // sources.id in config/db.js
const PAGE_SIZE = 200;
const SEARCH_SIZE = 30;
const MAX_OFFSET = 100000;

function parseOffset(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    const n = Number(cursor);
    if (!Number.isInteger(n) || n < 0 || n > MAX_OFFSET) throw new SourceError('BAD_CURSOR', 'Invalid cursor.', { source: SOURCE });
    return n;
}

function toTrack(row) {
    return makeTrack({
        source: SOURCE,
        id: row.id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        durationSec: row.duration_sec,
        playable: true,
        format: row.format || null
    });
}

const TRACK_COLUMNS = 't.id, t.title, t.artist, t.album, t.duration_sec, t.format';
// Artist, then album, then the album's track order, then title.
const TRACK_ORDER = `ORDER BY COALESCE(t.artist, '') COLLATE NOCASE, COALESCE(t.album, '') COLLATE NOCASE,
                     COALESCE(t.track_no, 0), t.title COLLATE NOCASE, t.id`;

async function getPlaylists({ db, userId }) {
    const rows = await db.all(
        `SELECT id, path, file_count FROM local_folders WHERE user_id = ? ORDER BY added_at`,
        [userId]
    );
    return page(rows.map((r) => makePlaylist({
        source: SOURCE,
        id: r.id,
        kind: 'playlist',
        name: path.basename(r.path) || r.path,
        itemCount: r.file_count,
        readOnly: true
    })), null);
}

async function getPlaylistTracks({ db, userId }, folderId, { cursor } = {}) {
    if (!/^[0-9]{1,12}$/.test(String(folderId))) throw new SourceError('NOT_FOUND', 'Folder not found.', { source: SOURCE });
    const owned = await db.get(`SELECT id FROM local_folders WHERE id = ? AND user_id = ?`, [Number(folderId), userId]);
    if (!owned) throw new SourceError('NOT_FOUND', 'Folder not found.', { source: SOURCE });
    const offset = parseOffset(cursor);
    const rows = await db.all(
        `SELECT ${TRACK_COLUMNS} FROM local_tracks t WHERE t.folder_id = ? ${TRACK_ORDER} LIMIT ? OFFSET ?`,
        [Number(folderId), PAGE_SIZE + 1, offset]
    );
    const hasMore = rows.length > PAGE_SIZE;
    return page(rows.slice(0, PAGE_SIZE).map(toTrack), hasMore ? String(offset + PAGE_SIZE) : null);
}

// LIKE with the wildcards in the user's text taken literally.
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function search({ db, userId }, query, { cursor } = {}) {
    const offset = parseOffset(cursor);
    const pattern = likePattern(query);
    const rows = await db.all(
        `SELECT ${TRACK_COLUMNS} FROM local_tracks t JOIN local_folders f ON f.id = t.folder_id
         WHERE f.user_id = ? AND (t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\' OR t.album LIKE ? ESCAPE '\\')
         ${TRACK_ORDER} LIMIT ? OFFSET ?`,
        [userId, pattern, pattern, pattern, SEARCH_SIZE + 1, offset]
    );
    const hasMore = rows.length > SEARCH_SIZE;
    return page(rows.slice(0, SEARCH_SIZE).map(toTrack), hasMore ? String(offset + SEARCH_SIZE) : null);
}

module.exports = {
    name: SOURCE,
    label: LABEL,
    sourceId: SOURCE_ID,
    connect: { kind: 'none', required: false },
    capabilities: { search: true, playlists: true, liked: false, like: false, stream: true },
    searchRequiresToken: false,
    isAvailable: () => true,
    getPlaylists,
    getPlaylistTracks,
    search,
    toTrack
};
