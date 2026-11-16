// One sign-in: the cloud account (docs/cloud-data.md, "One sign-in").
//
// The app used to have accounts of its own on each computer, with the cloud
// account linked to one of them. Two logins for one person, and data that
// stayed behind in a local account nobody had linked. Now a person signs in
// with the cloud account and nothing else; the row in `users` that stands for
// them on this computer is only where their synced copy hangs.
//
// What is left over from before is handled here: accounts on this computer
// that are not signed in to any cloud account. When someone signs in, their
// playlists, history, service connections and music folders are moved into
// that person's account, and the old accounts are removed. (Decided by the
// owner, 16 Nov 2026: move it, do not ask, do not discard.)
const records = require('./cloud/records');

/**
 * Moves everything that belongs to accounts with no cloud sign-in into
 * `userId` and removes those accounts. Returns what was moved:
 * { accounts, playlists, tracks, plays, connections, folders }.
 * One transaction: all of it, or nothing.
 */
async function adoptLocalAccounts(db, userId) {
    const moved = { accounts: 0, playlists: 0, tracks: 0, plays: 0, connections: 0, folders: 0 };
    const leftovers = await db.all(
        'SELECT id FROM users WHERE id != ? AND id NOT IN (SELECT user_id FROM cloud_links) ORDER BY id',
        [userId]
    );
    if (leftovers.length === 0) return moved;

    await db.transaction(async () => {
        for (const { id: from } of leftovers) {
            // --- Playlists. One of the same name is merged into, track by
            // track; any other simply changes hands.
            const mine = new Map((await db.all('SELECT id, name FROM playlists WHERE user_id = ?', [userId]))
                .map((p) => [p.name.trim().toLowerCase(), p.id]));
            for (const playlist of await db.all('SELECT id, name FROM playlists WHERE user_id = ? ORDER BY id', [from])) {
                const key = playlist.name.trim().toLowerCase();
                const target = mine.get(key);
                if (target === undefined) {
                    // Its cross-computer id is dropped: it is a new playlist as
                    // far as this cloud account is concerned.
                    await db.run('UPDATE playlists SET user_id = ?, sync_id = NULL WHERE id = ?', [userId, playlist.id]);
                    mine.set(key, playlist.id);
                    moved.playlists += 1;
                    moved.tracks += (await db.get('SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?', [playlist.id])).n;
                    continue;
                }
                // After what is there already, in the order they had.
                const last = await db.get('SELECT COALESCE(MAX(sort_order), 0) AS n FROM playlist_tracks WHERE playlist_id = ?', [target]);
                const added = await db.run(
                    `UPDATE playlist_tracks SET playlist_id = ?, sort_order = ? + id
                     WHERE playlist_id = ? AND track_id NOT IN (SELECT track_id FROM playlist_tracks WHERE playlist_id = ?)`,
                    [target, Math.max(last.n, Date.now()), playlist.id, target]
                );
                moved.tracks += added.changes;
                await db.run('DELETE FROM playlists WHERE id = ?', [playlist.id]); // with the tracks that were in both
            }

            // --- History: one entry per track, the latest play.
            for (const play of await db.all('SELECT id, track_id, played_at FROM history WHERE user_id = ?', [from])) {
                const own = await db.get('SELECT id, played_at FROM history WHERE user_id = ? AND track_id = ?', [userId, play.track_id]);
                if (!own) {
                    await db.run('UPDATE history SET user_id = ? WHERE id = ?', [userId, play.id]);
                    moved.plays += 1;
                } else if (String(play.played_at) > String(own.played_at)) {
                    await db.run('UPDATE history SET played_at = ? WHERE id = ?', [play.played_at, own.id]);
                }
            }

            // --- Connected services and music folders: kept where this
            // account has none of its own for the same service or folder.
            moved.connections += (await db.run(
                `UPDATE user_connections SET user_id = ?
                 WHERE user_id = ? AND source_id NOT IN (SELECT source_id FROM user_connections WHERE user_id = ?)`,
                [userId, from, userId]
            )).changes;
            moved.folders += (await db.run(
                `UPDATE local_folders SET user_id = ?
                 WHERE user_id = ? AND path NOT IN (SELECT path FROM local_folders WHERE user_id = ?)`,
                [userId, from, userId]
            )).changes;

            // --- What a person decided about matches stays decided.
            await db.run('UPDATE match_reports SET user_id = ? WHERE user_id = ?', [userId, from]);
            await db.run('UPDATE track_matches SET override_by = ? WHERE override_by = ?', [userId, from]);

            // The account itself; whatever still points at it goes with it.
            await db.run('DELETE FROM users WHERE id = ?', [from]);
            moved.accounts += 1;
        }
        await records.trimHistory(db, userId);
    });
    return moved;
}

module.exports = { adoptLocalAccounts };
