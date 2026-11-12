// What is synced, and how it maps to this computer's tables.
//
// Three collections:
//   playlists        a custom playlist                   id: its sync_id
//   playlist_tracks  one track in a custom playlist      id: <playlist sync_id>:<track key>
//   history          the last play of one track          id: <track key>
// A track key is a hash of its source and its id there, so it is the same on
// every computer. Tracks from Local Files are left out: they are files on one
// computer's disk and mean nothing on another.
//
// collect() reads the user's records as the cloud would hold them; apply()
// writes one record that came from the cloud. What collect() returns for a
// record that apply() just wrote must be what was applied, so both go through
// the same cleaning (services/trackMeta.js) and the same time resolution
// (whole seconds, as the tables store them).
const crypto = require('crypto');
const { cleanTrackMeta } = require('../trackMeta');

// Applied in this order, so a playlist exists before its tracks arrive.
const COLLECTIONS = ['playlists', 'playlist_tracks', 'history'];
const UNSYNCED_SOURCES = new Set(['local']);
const HISTORY_LIMIT = 50; // same as controllers/historyController.js
const MAX_NAME = 120;

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
const trackKey = (source, externalId) => sha1(`${source}\n${externalId}`);
const hashOf = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const keyOf = (collection, id) => `${collection}\n${id}`;

const httpsOrNull = (value) => (typeof value === 'string' && /^https:\/\//.test(value) && value.length <= 2000 ? value : null);

/** The user's synced records now: Map<key, { collection, id, data, version }>. */
async function collect(db, userId) {
    const out = new Map();
    // `firstSeen`: the record's own time, used when the cloud has never heard
    // of it (a playlist's creation, a play). `changed`: its own time for a
    // later change, where it has one (a play's time); otherwise the change is
    // dated when it is noticed.
    const add = (collection, id, data, firstSeen = null, changed = null) =>
        out.set(keyOf(collection, id), { collection, id, data, firstSeen, changed });

    // A playlist gets its cross-computer id the first time it is seen.
    const unnamed = await db.all('SELECT id FROM playlists WHERE user_id = ? AND sync_id IS NULL', [userId]);
    for (const row of unnamed) {
        await db.run('UPDATE playlists SET sync_id = ? WHERE id = ?', [crypto.randomUUID(), row.id]);
    }

    const playlists = await db.all(
        `SELECT sync_id, name, thumbnail, CAST(strftime('%s', created_at) AS INTEGER) AS created
         FROM playlists WHERE user_id = ?`,
        [userId]
    );
    for (const p of playlists) {
        const createdAt = (p.created || 0) * 1000;
        add('playlists', p.sync_id, { name: p.name, thumbnail: httpsOrNull(p.thumbnail), createdAt }, createdAt || null);
    }

    const entries = await db.all(
        `SELECT p.sync_id AS playlist, s.name AS source, t.external_id AS externalId,
                COALESCE(pt.title, t.title) AS title, COALESCE(pt.artist, t.artist) AS artist,
                CASE WHEN pt.title IS NOT NULL THEN pt.thumbnail ELSE t.thumbnail END AS thumbnail,
                -- Where the track sits in its playlist. Rows from before the
                -- order was recorded have 0: their row id keeps them in the
                -- order they were added, ahead of anything added since.
                CASE WHEN pt.sort_order > 0 THEN pt.sort_order ELSE pt.id END AS position
         FROM playlist_tracks pt
         JOIN playlists p ON p.id = pt.playlist_id
         JOIN tracks t ON t.id = pt.track_id
         JOIN sources s ON s.id = t.source_id
         WHERE p.user_id = ?
         ORDER BY pt.id`,
        [userId]
    );
    for (const e of entries) {
        if (UNSYNCED_SOURCES.has(e.source)) continue;
        const meta = cleanTrackMeta({ title: e.title, artist: e.artist, thumbnail: e.thumbnail });
        if (!meta) continue;
        add('playlist_tracks', `${e.playlist}:${trackKey(e.source, e.externalId)}`, {
            playlist: e.playlist, source: e.source, externalId: e.externalId,
            title: meta.title, artist: meta.artist, thumbnail: meta.thumbnail, position: e.position
        });
    }

    const plays = await db.all(
        `SELECT s.name AS source, t.external_id AS externalId,
                COALESCE(h.title, t.title) AS title, COALESCE(h.artist, t.artist) AS artist,
                CASE WHEN h.title IS NOT NULL THEN h.thumbnail ELSE t.thumbnail END AS thumbnail,
                CAST(strftime('%s', h.played_at) AS INTEGER) AS played
         FROM history h
         JOIN tracks t ON t.id = h.track_id
         JOIN sources s ON s.id = t.source_id
         WHERE h.user_id = ?`,
        [userId]
    );
    for (const h of plays) {
        if (UNSYNCED_SOURCES.has(h.source)) continue;
        const meta = cleanTrackMeta({ title: h.title, artist: h.artist, thumbnail: h.thumbnail });
        if (!meta) continue;
        const playedAt = (h.played || 0) * 1000;
        add('history', trackKey(h.source, h.externalId), {
            source: h.source, externalId: h.externalId,
            title: meta.title, artist: meta.artist, thumbnail: meta.thumbnail, playedAt
        }, playedAt || null, playedAt || null);
    }
    return out;
}

// The shared `tracks` row for a (source, id), created if needed. Null for a
// source this installation does not know, or one that is not synced.
async function trackRow(db, data) {
    const { source, externalId } = data || {};
    if (typeof source !== 'string' || UNSYNCED_SOURCES.has(source)) return null;
    if (typeof externalId !== 'string' || !externalId || externalId.length > 200) return null;
    const meta = cleanTrackMeta({ title: data.title, artist: data.artist, thumbnail: data.thumbnail });
    if (!meta) return null;
    const src = await db.get('SELECT id FROM sources WHERE name = ?', [source]);
    if (!src) return null;
    await db.run(
        'INSERT OR IGNORE INTO tracks (source_id, external_id, title, artist, thumbnail) VALUES (?, ?, ?, ?, ?)',
        [src.id, externalId, meta.title, meta.artist, meta.thumbnail]
    );
    const track = await db.get('SELECT id FROM tracks WHERE source_id = ? AND external_id = ?', [src.id, externalId]);
    return track ? { trackId: track.id, meta } : null;
}

// Finds the row whose track key matches, among `rows` ({ id, source, externalId }).
const rowWithKey = (rows, key) => rows.find((r) => trackKey(r.source, r.externalId) === key) || null;

async function applyPlaylist(db, userId, change) {
    if (change.deleted) {
        await db.run('DELETE FROM playlists WHERE user_id = ? AND sync_id = ?', [userId, change.id]);
        return true;
    }
    const data = change.data || {};
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > MAX_NAME) return false;
    if (!/^[0-9a-f-]{36}$/.test(change.id)) return false;
    const thumbnail = httpsOrNull(data.thumbnail);
    const created = Number.isFinite(data.createdAt) && data.createdAt > 0 ? Math.floor(data.createdAt / 1000) : Math.floor(Date.now() / 1000);
    const existing = await db.get('SELECT id, user_id FROM playlists WHERE sync_id = ?', [change.id]);
    if (existing) {
        if (existing.user_id !== userId) return false; // another local account's playlist: not ours to touch
        await db.run('UPDATE playlists SET name = ?, thumbnail = ? WHERE id = ?', [data.name.trim(), thumbnail, existing.id]);
    } else {
        await db.run(
            `INSERT INTO playlists (user_id, name, thumbnail, created_at, sync_id) VALUES (?, ?, ?, datetime(?, 'unixepoch'), ?)`,
            [userId, data.name.trim(), thumbnail, created, change.id]
        );
    }
    return true;
}

async function applyPlaylistTrack(db, userId, change) {
    const [playlistSyncId, key] = String(change.id).split(':');
    const playlist = await db.get('SELECT id FROM playlists WHERE user_id = ? AND sync_id = ?', [userId, playlistSyncId || '']);
    if (change.deleted) {
        if (!playlist) return true; // the playlist is gone, and its tracks with it
        const rows = await db.all(
            `SELECT pt.id, s.name AS source, t.external_id AS externalId
             FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id JOIN sources s ON s.id = t.source_id
             WHERE pt.playlist_id = ?`,
            [playlist.id]
        );
        const row = rowWithKey(rows, key);
        if (row) await db.run('DELETE FROM playlist_tracks WHERE id = ?', [row.id]);
        return true;
    }
    const data = change.data || {};
    if (!playlist || data.playlist !== playlistSyncId) return false;
    if (trackKey(data.source, data.externalId) !== key) return false;
    const track = await trackRow(db, data);
    if (!track) return false;
    // Its place in the playlist travels with it, so the order is the same everywhere.
    const position = Number.isSafeInteger(data.position) && data.position > 0 ? data.position : Date.now();
    const existing = await db.get('SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlist.id, track.trackId]);
    if (existing) {
        await db.run('UPDATE playlist_tracks SET title = ?, artist = ?, thumbnail = ?, sort_order = ? WHERE id = ?',
            [track.meta.title, track.meta.artist, track.meta.thumbnail, position, existing.id]);
    } else {
        await db.run('INSERT INTO playlist_tracks (playlist_id, track_id, title, artist, thumbnail, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
            [playlist.id, track.trackId, track.meta.title, track.meta.artist, track.meta.thumbnail, position]);
    }
    return true;
}

async function applyHistory(db, userId, change) {
    if (change.deleted) {
        const rows = await db.all(
            `SELECT h.id, s.name AS source, t.external_id AS externalId
             FROM history h JOIN tracks t ON t.id = h.track_id JOIN sources s ON s.id = t.source_id
             WHERE h.user_id = ?`,
            [userId]
        );
        const row = rowWithKey(rows, change.id);
        if (row) await db.run('DELETE FROM history WHERE id = ?', [row.id]);
        return true;
    }
    const data = change.data || {};
    if (trackKey(data.source, data.externalId) !== change.id) return false;
    if (!Number.isFinite(data.playedAt) || data.playedAt <= 0) return false;
    const track = await trackRow(db, data);
    if (!track) return false;
    await db.run('DELETE FROM history WHERE user_id = ? AND track_id = ?', [userId, track.trackId]);
    await db.run(
        `INSERT INTO history (user_id, track_id, title, artist, thumbnail, played_at) VALUES (?, ?, ?, ?, ?, datetime(?, 'unixepoch'))`,
        [userId, track.trackId, track.meta.title, track.meta.artist, track.meta.thumbnail, Math.floor(data.playedAt / 1000)]
    );
    return true;
}

const APPLIERS = { playlists: applyPlaylist, playlist_tracks: applyPlaylistTrack, history: applyHistory };

/**
 * Writes one record from the cloud into this computer's tables. Returns false
 * when it could not be used here (an unknown collection or source, a track of
 * a playlist that no longer exists, malformed content); that is not an error.
 */
async function apply(db, userId, change) {
    const applier = APPLIERS[change.collection];
    if (!applier || typeof change.id !== 'string') return false;
    return applier(db, userId, change);
}

/** Keeps the newest plays only, as logging a play does. */
async function trimHistory(db, userId) {
    await db.run(
        `DELETE FROM history WHERE user_id = ? AND id NOT IN (
            SELECT id FROM history WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ?)`,
        [userId, userId, HISTORY_LIMIT]
    );
}

module.exports = { COLLECTIONS, collect, apply, trimHistory, hashOf, keyOf, trackKey };
