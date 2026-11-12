import { describe, expect, it } from 'vitest';
import { account, call, change, env, DEVICE_A, DEVICE_B } from './helpers';

const T = 1_794_000_000_000; // a fixed "now" on the devices, in milliseconds

const push = (token: string, changes: unknown[], deviceId = DEVICE_A) =>
    call('/sync/push', { method: 'POST', token, body: { deviceId, changes } });
const pull = async (token: string, query = '') => (await call(`/sync/pull${query}`, { token })).json;

describe('pushing and pulling', () => {
    it('one device pushes, another pulls the same records, in the order they were accepted', async () => {
        const token = await account();
        const sent = await push(token, [change('p1', T, { name: 'Road Trip' }), change('p2', T + 1, { name: 'Focus' }), change('h1', T + 2, { trackId: 'abc' }, 'history')]);
        expect(sent).toMatchObject({ status: 200, json: { received: 3, cursor: 3 } });

        const got = await pull(token);
        expect(got.more).toBe(false);
        expect(got.cursor).toBe(3);
        expect(got.changes).toEqual([
            { collection: 'playlists', id: 'p1', updatedAt: T, deleted: false, data: { name: 'Road Trip' }, seq: 1, deviceId: DEVICE_A },
            { collection: 'playlists', id: 'p2', updatedAt: T + 1, deleted: false, data: { name: 'Focus' }, seq: 2, deviceId: DEVICE_A },
            { collection: 'history', id: 'h1', updatedAt: T + 2, deleted: false, data: { trackId: 'abc' }, seq: 3, deviceId: DEVICE_A }
        ]);
        // A device that is up to date gets nothing, and keeps its cursor.
        expect(await pull(token, '?since=3')).toEqual({ changes: [], cursor: 3, more: false });
    });

    it('only hands out what came after the cursor, a page at a time', async () => {
        const token = await account();
        await push(token, Array.from({ length: 7 }, (_, i) => change(`p${i}`, T + i)));
        const first = await pull(token, '?limit=3');
        expect(first.changes.map((c: any) => c.id)).toEqual(['p0', 'p1', 'p2']);
        expect(first).toMatchObject({ cursor: 3, more: true });
        const second = await pull(token, `?since=${first.cursor}&limit=3`);
        expect(second.changes.map((c: any) => c.id)).toEqual(['p3', 'p4', 'p5']);
        const third = await pull(token, `?since=${second.cursor}&limit=3`);
        expect(third.changes.map((c: any) => c.id)).toEqual(['p6']);
        expect(third).toMatchObject({ cursor: 7, more: false });
    });

    it('a changed record moves to the end of the line, so devices that saw the old one get the new one', async () => {
        const token = await account();
        await push(token, [change('p1', T, { name: 'Old' }), change('p2', T)]);
        await push(token, [change('p1', T + 10, { name: 'New' })], DEVICE_B);
        const got = await pull(token, '?since=2');
        expect(got.changes).toEqual([{ collection: 'playlists', id: 'p1', updatedAt: T + 10, deleted: false, data: { name: 'New' }, seq: 3, deviceId: DEVICE_B }]);
        // Still one row per record.
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first()).toEqual({ n: 2 });
    });
});

describe('two devices changing the same record', () => {
    it('the newer change wins, whichever arrives first', async () => {
        const token = await account();
        await push(token, [change('p1', T + 100, { name: 'Newer, from A' })], DEVICE_A);
        // B was offline and pushes an older edit afterwards: it must not win.
        await push(token, [change('p1', T + 50, { name: 'Older, from B' })], DEVICE_B);
        let all = await pull(token);
        expect(all.changes).toHaveLength(1);
        expect(all.changes[0].data).toEqual({ name: 'Newer, from A' });
        // B's device does not get a new change number for its rejected edit.
        expect(all.changes[0]).toMatchObject({ seq: 1, deviceId: DEVICE_A });

        await push(token, [change('p1', T + 200, { name: 'Newest, from B' })], DEVICE_B);
        all = await pull(token);
        expect(all.changes[0]).toMatchObject({ data: { name: 'Newest, from B' }, deviceId: DEVICE_B });
    });

    it('at the very same time, every device agrees on the same winner', async () => {
        const token = await account();
        await push(token, [change('p1', T, { name: 'from A' })], DEVICE_A);
        await push(token, [change('p1', T, { name: 'from B' })], DEVICE_B);
        expect((await pull(token)).changes[0].data).toEqual({ name: 'from B' });

        // The other order of arrival gives the same result.
        const other = await account('second', '2');
        await push(other, [change('p1', T, { name: 'from B' })], DEVICE_B);
        await push(other, [change('p1', T, { name: 'from A' })], DEVICE_A);
        expect((await pull(other)).changes[0].data).toEqual({ name: 'from B' });
    });

    it('a deletion is a change like any other: it travels, and a later edit brings the record back', async () => {
        const token = await account();
        await push(token, [change('p1', T, { name: 'Gone soon' })]);
        await push(token, [change('p1', T + 10, null)], DEVICE_B);
        let got = await pull(token, '?since=1');
        expect(got.changes).toEqual([{ collection: 'playlists', id: 'p1', updatedAt: T + 10, deleted: true, data: null, seq: 2, deviceId: DEVICE_B }]);
        // An edit made before the deletion loses to it.
        await push(token, [change('p1', T + 5, { name: 'Edited before the deletion' })]);
        expect((await pull(token)).changes[0].deleted).toBe(true);
        await push(token, [change('p1', T + 20, { name: 'Back' })]);
        got = await pull(token);
        expect(got.changes[0]).toMatchObject({ deleted: false, data: { name: 'Back' } });
    });

    it('the same record twice in one push: the later entry wins', async () => {
        const token = await account();
        await push(token, [change('p1', T, { name: 'first' }), change('p1', T + 1, { name: 'second' })]);
        const got = await pull(token);
        expect(got.changes).toHaveLength(1);
        expect(got.changes[0].data).toEqual({ name: 'second' });
    });
});

describe('accounts are separate', () => {
    it('one account never sees or overwrites another account\'s records', async () => {
        const mine = await account('shimi', '1');
        const theirs = await account('other', '2');
        await push(mine, [change('p1', T, { name: 'Mine' })]);
        await push(theirs, [change('p1', T + 999, { name: 'Theirs' })]);
        expect((await pull(mine)).changes.map((c: any) => c.data.name)).toEqual(['Mine']);
        expect((await pull(theirs)).changes.map((c: any) => c.data.name)).toEqual(['Theirs']);
        // Each account counts its own changes.
        expect((await pull(mine)).cursor).toBe(1);
        expect((await pull(theirs)).cursor).toBe(1);
    });

    it('deleting an account removes its records and nobody else\'s', async () => {
        const mine = await account('shimi', '1');
        const theirs = await account('other', '2');
        await push(mine, [change('p1', T), change('p2', T)]);
        await push(theirs, [change('p1', T)]);
        const { keyFor } = await import('./helpers');
        expect((await call('/auth/account', { method: 'DELETE', token: mine, body: { authKey: keyFor('1') } })).status).toBe(204);
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first()).toEqual({ n: 1 });
        expect((await pull(theirs)).changes).toHaveLength(1);
    });
});

describe('what a push may contain', () => {
    it('refuses malformed changes and stores nothing from a refused push', async () => {
        const token = await account();
        const good = change('ok', T);
        const bad: unknown[] = [
            null, 'text', { ...good, collection: 'Playlists' }, { ...good, collection: 'a b' }, { ...good, collection: '../x' },
            { ...good, id: '' }, { ...good, id: 'x'.repeat(201) }, { ...good, id: 7 }, { ...good, id: 'line\nbreak' },
            { ...good, updatedAt: 'now' }, { ...good, updatedAt: -1 }, { ...good, updatedAt: 1.5 },
            { ...good, data: 'text' }, { ...good, data: ['list'] }, { ...good, data: null }, { collection: 'playlists', id: 'x', updatedAt: T }
        ];
        for (const item of bad) {
            const res = await push(token, [good, item]);
            expect([JSON.stringify(item), res.status, res.json.code]).toEqual([JSON.stringify(item), 400, 'BAD_CHANGE']);
        }
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first()).toEqual({ n: 0 });
        expect((await pull(token)).cursor).toBe(0);
    });

    it('refuses a bad device id, a missing list, too many changes, oversized data and a clock far in the future', async () => {
        const token = await account();
        for (const deviceId of [undefined, '', 'short', 'has space!', 'x'.repeat(65), 42]) {
            expect(await call('/sync/push', { method: 'POST', token, body: { deviceId, changes: [] } })).toMatchObject({ status: 400, json: { code: 'BAD_DEVICE' } });
        }
        expect(await call('/sync/push', { method: 'POST', token, body: { deviceId: DEVICE_A } })).toMatchObject({ status: 400, json: { code: 'BAD_CHANGES' } });
        expect(await push(token, Array.from({ length: 501 }, (_, i) => change(`p${i}`, T)))).toMatchObject({ status: 413, json: { code: 'TOO_MANY_CHANGES' } });
        expect(await push(token, [change('big', T, { blob: 'x'.repeat(17000) })])).toMatchObject({ status: 413, json: { code: 'CHANGE_TOO_LARGE' } });
        expect(await push(token, [change('later', Date.now() + 3 * 24 * 60 * 60 * 1000)])).toMatchObject({ status: 400, json: { code: 'CLOCK_AHEAD' } });
        expect(await push(token, [])).toMatchObject({ status: 200, json: { received: 0, cursor: 0 } });
    });

    it('takes a full push of 500 records in one go, and text that looks like SQL is just text', async () => {
        const token = await account();
        const nasty = "'); DROP TABLE records; --";
        const many = Array.from({ length: 500 }, (_, i) => change(`p${i}`, T + i, { name: i === 0 ? nasty : `Playlist ${i}`, emoji: '🎵', nested: { ok: true } }));
        expect(await push(token, many)).toMatchObject({ status: 200, json: { received: 500, cursor: 500 } });
        const got = await pull(token, '?limit=500');
        expect(got.changes).toHaveLength(500);
        expect(got.changes[0].data).toEqual({ name: nasty, emoji: '🎵', nested: { ok: true } });
        expect(got.changes[499]).toMatchObject({ id: 'p499', seq: 500 });
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM records').first()).toEqual({ n: 500 });
    });

    it('refuses bad pull parameters', async () => {
        const token = await account();
        for (const query of ['?since=-1', '?since=abc', '?limit=0', '?limit=501', '?limit=1.5']) {
            expect(await call(`/sync/pull${query}`, { token })).toMatchObject({ status: 400, json: { code: 'BAD_PARAMETER' } });
        }
    });
});

describe('staying inside the free plan', () => {
    it('a pull reads only the rows it returns, however many records the account has', async () => {
        const token = await account();
        await push(token, Array.from({ length: 400 }, (_, i) => change(`p${i}`, T + i)));
        const user = await env.DB.prepare('SELECT id FROM users').first<{ id: number }>();
        const result = await env.DB
            .prepare('SELECT collection, record_id, data, updated_at, deleted, seq, device_id FROM records WHERE user_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3')
            .bind(user!.id, 395, 11)
            .all();
        expect(result.results).toHaveLength(5);
        // D1 reports the rows it scanned: the index keeps that at the rows returned.
        expect(result.meta.rows_read).toBeLessThanOrEqual(10);
        const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT * FROM records WHERE user_id = 1 AND seq > 5 ORDER BY seq LIMIT 10').all<{ detail: string }>();
        expect(plan.results.map((r) => r.detail).join(' ')).toMatch(/USING INDEX idx_records_user_seq/);
    });
});
