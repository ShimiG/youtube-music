// docs/performance-plan.md, step 4.2: a local folder is paged by "the rows
// after this one" (providers/local.js), on a real database.
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
let db;
let local;

const ARTISTS = ['ABBA', 'abba', 'Abba', null, '', 'Björk', 'björk', 'Zed', 'a-ha', 'A-ha'];
const ALBUMS = ['Gold', 'gold', null, '', 'Arrival'];

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-paging-'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    db = await require('../config/db')(path.join(dir, 'database.sqlite'));
    local = require('../providers/local');
    await db.run(`INSERT INTO users (id, username, password) VALUES (1, 'a', 'x'), (2, 'b', 'x')`);
    await db.run(`INSERT INTO local_folders (id, user_id, path, added_at) VALUES (1, 1, '/music', 1), (2, 1, '/other', 2), (3, 2, '/theirs', 3)`);
    // 1,003 tracks whose order turns on every part of the sort: upper and
    // lower case that sort together, missing artists and albums, the same
    // title many times, missing track numbers.
    await db.transaction(async () => {
        for (let i = 0; i < 1003; i++) {
            await db.run(
                `INSERT INTO local_tracks (folder_id, rel_path, size, mtime_ms, title, artist, album, track_no, duration_sec, format)
                 VALUES (1, ?, 1, 1, ?, ?, ?, ?, 200, 'mp3')`,
                [`f${i}.mp3`, i % 7 === 0 ? 'Same Title' : `Song ${(i * 37) % 101}`, ARTISTS[i % ARTISTS.length], ALBUMS[(i * 3) % ALBUMS.length], i % 4 === 0 ? null : (i % 13)]
            );
        }
        await db.run(`INSERT INTO local_tracks (folder_id, rel_path, size, mtime_ms, title) VALUES (2, 'x.mp3', 1, 1, 'Elsewhere')`);
    });
});

afterAll(async () => {
    await db.close();
    console.log.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = { get db() { return db; }, userId: 1 };
async function pageThrough(folderId, onPage = () => {}) {
    const ids = [];
    let cursor;
    for (let pages = 0; pages < 20; pages++) {
        const result = await local.getPlaylistTracks(ctx, folderId, { cursor });
        ids.push(...result.items.map((t) => Number(t.id)));
        await onPage(result, pages);
        if (!result.nextCursor) return ids;
        cursor = result.nextCursor;
    }
    throw new Error('never reached the end');
}

it('pages through a folder in exactly the order of one full listing, each track once', async () => {
    const expected = (await db.all(
        `SELECT t.id FROM local_tracks t WHERE t.folder_id = 1
         ORDER BY COALESCE(t.artist, '') COLLATE NOCASE, COALESCE(t.album, '') COLLATE NOCASE, COALESCE(t.track_no, 0), t.title COLLATE NOCASE, t.id`
    )).map((r) => r.id);
    const sizes = [];
    const got = await pageThrough(1, (result) => sizes.push(result.items.length));
    expect(got).toEqual(expected);
    expect(sizes).toEqual([200, 200, 200, 200, 200, 3]);
    expect(new Set(got).size).toBe(1003);
});

it('finds a page through the index, without reading the rows before it', async () => {
    const plan = await db.all(
        `EXPLAIN QUERY PLAN SELECT t.id FROM local_tracks t
         WHERE t.folder_id = ? AND COALESCE(t.artist, '') COLLATE NOCASE >= ?
           AND (COALESCE(t.artist, '') COLLATE NOCASE, COALESCE(t.album, '') COLLATE NOCASE,
                   COALESCE(t.track_no, 0), t.title COLLATE NOCASE, t.id) > (?, ?, ?, ?, ?)
         ORDER BY COALESCE(t.artist, '') COLLATE NOCASE, COALESCE(t.album, '') COLLATE NOCASE,
                     COALESCE(t.track_no, 0), t.title COLLATE NOCASE, t.id LIMIT ?`,
        [1, 'Zed', 'Zed', '', 0, 'x', 1, 201]
    );
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/SEARCH t USING INDEX idx_local_tracks_order \(folder_id=\? AND <expr>>\?\)/);
    expect(detail).not.toMatch(/TEMP B-TREE/); // already in order: no sorting step
    // The index that only repeated the start of two others is gone.
    const names = (await db.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'local_tracks'`)).map((r) => r.name);
    expect(names).toContain('idx_local_tracks_order');
    expect(names).not.toContain('idx_local_tracks_folder');
});

it('carries on from the right place when the track the cursor names has been removed', async () => {
    const expected = await pageThrough(1);
    let removed;
    const got = await pageThrough(1, async (result, pages) => {
        if (pages !== 1) return;
        // A rescan removes the last track of the second page before the third is asked for.
        removed = Number(result.items[result.items.length - 1].id);
        await db.run('DELETE FROM local_tracks WHERE id = ?', [removed]);
    });
    // Skipping by count after a removal passes over one track; nothing is sent twice and it ends.
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(expected.length - 1);
    expect(got.slice(0, 400)).toEqual(expected.slice(0, 400));
});

it('refuses cursors it did not hand out, and folders that are not the user\'s', async () => {
    for (const cursor of ['200', 'k', 'k1', 'k1.', 'k1.x', 'k-1.5', 'k1.99999999', "k1.2' OR 1=1", 'k1.2.3']) {
        await expect(local.getPlaylistTracks(ctx, 1, { cursor })).rejects.toMatchObject({ code: 'BAD_CURSOR' });
    }
    // A cursor from another folder is not a place in this one: the count is used.
    const other = await local.getPlaylistTracks(ctx, 2, {});
    expect(other.items).toHaveLength(1);
    expect(other.nextCursor).toBeNull();
    const first = await local.getPlaylistTracks(ctx, 1, {});
    expect((await local.getPlaylistTracks(ctx, 2, { cursor: first.nextCursor })).items).toEqual([]);
    await expect(local.getPlaylistTracks(ctx, 3, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
