// The synced records: push changes up, pull everyone else's down.
//
// A device sends the records it changed, each with the time of the change.
// For one record the newer change wins (equal times: the device with the
// larger id, so every device agrees). Every accepted push gets the account's
// next change numbers; a device pulls "everything after the last number I
// saw". Deletions are records too (deleted: true), so they travel the same way.
//
// Shaped by D1's free-plan limits: a push is ONE statement however many
// records it carries (the records travel as one JSON parameter, unpacked by
// json_each), wrapped with the counter update in one transaction; a pull reads
// only the rows it returns, through the (user_id, seq) index.
import { ApiError, type Env } from './types';

export const MAX_CHANGES_PER_PUSH = 500;
export const MAX_DATA_BYTES = 16 * 1024;
export const MAX_PULL = 500;

const COLLECTION = /^[a-z][a-z0-9_]{0,31}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ID_CHARS = 200;
// Refuse changes dated far in the future: one wrong clock must not make a
// record impossible to change for years.
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

export interface Change {
    collection: string;
    id: string;
    updatedAt: number;
    deleted: boolean;
    data: unknown;
}

function cleanChange(raw: unknown, index: number, now: number): Change {
    const where = `changes[${index}]`;
    if (!raw || typeof raw !== 'object') throw new ApiError(400, 'BAD_CHANGE', `${where} is not an object.`);
    const input = raw as Record<string, unknown>;
    const { collection, id, updatedAt } = input;
    if (typeof collection !== 'string' || !COLLECTION.test(collection)) {
        throw new ApiError(400, 'BAD_CHANGE', `${where}.collection must be a short lower-case name.`);
    }
    // eslint-disable-next-line no-control-regex
    if (typeof id !== 'string' || !id || id.length > MAX_ID_CHARS || /[\u0000-\u001f]/.test(id)) {
        throw new ApiError(400, 'BAD_CHANGE', `${where}.id must be a non-empty string of at most ${MAX_ID_CHARS} characters.`);
    }
    if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
        throw new ApiError(400, 'BAD_CHANGE', `${where}.updatedAt must be a time in milliseconds.`);
    }
    if (updatedAt > now + MAX_CLOCK_AHEAD_MS) {
        throw new ApiError(400, 'CLOCK_AHEAD', `${where}.updatedAt is in the future. Check this device's clock.`);
    }
    const deleted = input.deleted === true;
    let data: unknown = null;
    if (!deleted) {
        if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
            throw new ApiError(400, 'BAD_CHANGE', `${where}.data must be an object (or the change must be a deletion).`);
        }
        if (JSON.stringify(input.data).length > MAX_DATA_BYTES) {
            throw new ApiError(413, 'CHANGE_TOO_LARGE', `${where}.data is larger than ${MAX_DATA_BYTES} bytes.`);
        }
        data = input.data;
    }
    return { collection, id, updatedAt, deleted, data };
}

/** Stores a device's changes. Returns how many were sent and the account's new cursor. */
export async function push(env: Env, userId: number, body: unknown) {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const deviceId = input.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
        throw new ApiError(400, 'BAD_DEVICE', 'deviceId must be 8 to 64 letters, digits, dashes or underscores.');
    }
    if (!Array.isArray(input.changes)) throw new ApiError(400, 'BAD_CHANGES', 'changes must be a list.');
    if (input.changes.length > MAX_CHANGES_PER_PUSH) {
        throw new ApiError(413, 'TOO_MANY_CHANGES', `Send at most ${MAX_CHANGES_PER_PUSH} changes at a time.`);
    }
    const now = Date.now();
    const changes = input.changes.map((raw, index) => cleanChange(raw, index, now));
    if (changes.length === 0) {
        const row = await env.DB.prepare('SELECT last_seq FROM users WHERE id = ?').bind(userId).first<{ last_seq: number }>();
        return { received: 0, cursor: row?.last_seq ?? 0 };
    }

    // One transaction: reserve the numbers, then write every record with one
    // statement. json_each's `key` is the position in the list, so the records
    // get consecutive numbers in the order they were sent.
    const count = changes.length;
    const [reserved] = await env.DB.batch<{ last_seq: number }>([
        env.DB.prepare('UPDATE users SET last_seq = last_seq + ?1 WHERE id = ?2 RETURNING last_seq').bind(count, userId),
        env.DB.prepare(
            `INSERT INTO records (user_id, collection, record_id, data, updated_at, deleted, seq, device_id)
             SELECT ?1,
                    json_extract(value, '$.collection'),
                    json_extract(value, '$.id'),
                    CASE WHEN json_extract(value, '$.deleted') THEN NULL ELSE json_extract(value, '$.data') END,
                    json_extract(value, '$.updatedAt'),
                    CASE WHEN json_extract(value, '$.deleted') THEN 1 ELSE 0 END,
                    (SELECT last_seq FROM users WHERE id = ?1) - ?3 + key + 1,
                    ?4
             FROM json_each(?2)
             WHERE true
             ON CONFLICT (user_id, collection, record_id) DO UPDATE SET
                    data = excluded.data,
                    updated_at = excluded.updated_at,
                    deleted = excluded.deleted,
                    seq = excluded.seq,
                    device_id = excluded.device_id
             WHERE excluded.updated_at > records.updated_at
                OR (excluded.updated_at = records.updated_at AND excluded.device_id > records.device_id)`
        ).bind(userId, JSON.stringify(changes), count, deviceId)
    ]);
    const cursor = reserved?.results?.[0]?.last_seq;
    if (typeof cursor !== 'number') throw new ApiError(500, 'INTERNAL', 'The changes could not be stored.');
    return { received: count, cursor };
}

function wholeNumber(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        throw new ApiError(400, 'BAD_PARAMETER', `${name} must be a whole number from ${min} to ${max}.`);
    }
    return n;
}

/** The changes accepted after `since`, oldest first, at most `limit` of them. */
export async function pull(env: Env, userId: number, query: { since?: string; limit?: string }) {
    const since = wholeNumber(query.since, 0, 0, Number.MAX_SAFE_INTEGER, 'since');
    const limit = wholeNumber(query.limit, 200, 1, MAX_PULL, 'limit');
    // One row more than asked for tells whether there is more to fetch.
    const { results } = await env.DB
        .prepare(
            `SELECT collection, record_id, data, updated_at, deleted, seq, device_id
             FROM records WHERE user_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3`
        )
        .bind(userId, since, limit + 1)
        .all<{ collection: string; record_id: string; data: string | null; updated_at: number; deleted: number; seq: number; device_id: string }>();
    const more = results.length > limit;
    const page = more ? results.slice(0, limit) : results;
    const changes = page.map((row) => ({
        collection: row.collection,
        id: row.record_id,
        updatedAt: row.updated_at,
        deleted: row.deleted === 1,
        data: row.data === null ? null : JSON.parse(row.data),
        seq: row.seq,
        deviceId: row.device_id
    }));
    const last = page[page.length - 1];
    return { changes, cursor: last ? last.seq : since, more };
}
