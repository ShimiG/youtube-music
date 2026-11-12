import { describe, expect, it } from 'vitest';
import { account, call, env, keyFor } from './helpers';

describe('health', () => {
    it('says the service is up and whether sign-up is open, and nothing is cacheable', async () => {
        const res = await call('/health');
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: true, service: 'music-manager-cloud', registrationOpen: true });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect((await call('/health', { env: { REGISTRATION_CODE: undefined } })).json.registrationOpen).toBe(false);
    });

    it('answers unknown addresses and broken requests with a JSON error, not a crash', async () => {
        expect(await call('/nope')).toMatchObject({ status: 404, json: { code: 'NOT_FOUND' } });
        expect(await call('/auth/login', { method: 'POST', raw: '{not json' })).toMatchObject({ status: 400, json: { code: 'BAD_JSON' } });
        expect(await call('/auth/login', { method: 'POST', raw: 'x'.repeat(1024 * 1024 + 10) })).toMatchObject({ status: 413, json: { code: 'BODY_TOO_LARGE' } });
    });
});

describe('creating an account', () => {
    const body = { username: 'shimi', authKey: keyFor('1'), registrationCode: 'let-me-in' };

    it('needs the registration code, and gives a session back', async () => {
        const res = await call('/auth/register', { method: 'POST', body });
        expect(res.status).toBe(201);
        expect(res.json.token.split('.')).toHaveLength(3);
        expect(res.json.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

        expect(await call('/auth/register', { method: 'POST', body: { ...body, username: 'other', registrationCode: 'wrong' } }))
            .toMatchObject({ status: 403, json: { code: 'BAD_REGISTRATION_CODE' } });
        expect(await call('/auth/register', { method: 'POST', body: { username: 'other', authKey: keyFor('2') } }))
            .toMatchObject({ status: 403, json: { code: 'BAD_REGISTRATION_CODE' } });
    });

    it('is closed altogether when no registration code is set', async () => {
        const res = await call('/auth/register', { method: 'POST', body, env: { REGISTRATION_CODE: undefined } });
        expect(res).toMatchObject({ status: 403, json: { code: 'REGISTRATION_CLOSED' } });
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 0 });
    });

    it('stores a hash of the key, never the key, and refuses a taken name (whatever its case)', async () => {
        await call('/auth/register', { method: 'POST', body });
        const row = await env.DB.prepare('SELECT username, auth_hash FROM users').first<{ username: string; auth_hash: string }>();
        expect(row?.auth_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row?.auth_hash).not.toBe(keyFor('1'));
        expect(await call('/auth/register', { method: 'POST', body: { ...body, username: 'SHIMI' } }))
            .toMatchObject({ status: 409, json: { code: 'USERNAME_TAKEN' } });
    });

    it('refuses malformed names and keys', async () => {
        for (const username of ['', 'ab', 'has space', '../etc', 'x'.repeat(33), '-leading', 42, null]) {
            expect(await call('/auth/register', { method: 'POST', body: { ...body, username } }))
                .toMatchObject({ status: 400, json: { code: 'BAD_USERNAME' } });
        }
        for (const authKey of ['', 'short', 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(65), ['a'.repeat(64)], 7]) {
            expect(await call('/auth/register', { method: 'POST', body: { ...body, authKey } }))
                .toMatchObject({ status: 400, json: { code: 'BAD_AUTH_KEY' } });
        }
        expect(await call('/auth/register', { method: 'POST', body: [] })).toMatchObject({ status: 400 });
    });

    it('says it is not set up when the signing secret is missing or too short', async () => {
        for (const JWT_SECRET of [undefined, 'short']) {
            expect(await call('/auth/register', { method: 'POST', body, env: { JWT_SECRET } }))
                .toMatchObject({ status: 503, json: { code: 'NOT_CONFIGURED' } });
        }
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).toEqual({ n: 0 });
    });
});

describe('signing in', () => {
    it('works with the right key and gives the same answer for a wrong key and an unknown name', async () => {
        await account('shimi', '1');
        const ok = await call('/auth/login', { method: 'POST', body: { username: 'Shimi', authKey: keyFor('1') } });
        expect(ok.status).toBe(200);
        expect(ok.json.token).toBeTruthy();

        const wrongKey = await call('/auth/login', { method: 'POST', body: { username: 'shimi', authKey: keyFor('2') } });
        const noUser = await call('/auth/login', { method: 'POST', body: { username: 'nobody', authKey: keyFor('1') } });
        expect(wrongKey).toMatchObject({ status: 401, json: { code: 'BAD_CREDENTIALS' } });
        expect(noUser.status).toBe(wrongKey.status);
        expect(noUser.json).toEqual(wrongKey.json);
    });

    it('locks the account for a while after ten wrong keys in a row, and counts again after a success', async () => {
        await account('shimi', '1');
        const attempt = (seed: string) => call('/auth/login', { method: 'POST', body: { username: 'shimi', authKey: keyFor(seed) } });
        for (let i = 0; i < 9; i++) expect((await attempt('2')).status).toBe(401);
        expect((await attempt('1')).status).toBe(200); // a success resets the count
        for (let i = 0; i < 10; i++) expect((await attempt('2')).status).toBe(401);
        expect(await attempt('1')).toMatchObject({ status: 423, json: { code: 'LOCKED' } });
        // When the lock has run out, the right key works again.
        await env.DB.prepare('UPDATE users SET locked_until = ?').bind(Date.now() - 1000).run();
        expect((await attempt('1')).status).toBe(200);
    });

    it('the pepper is part of the stored hash: a database copy alone does not sign anyone in', async () => {
        await account('shimi', '1');
        const res = await call('/auth/login', { method: 'POST', body: { username: 'shimi', authKey: keyFor('1') }, env: { AUTH_PEPPER: 'another-pepper' } });
        expect(res.status).toBe(401);
    });
});

describe('sessions', () => {
    it('are needed for everything under /sync and for deleting the account', async () => {
        for (const [path, method] of [['/sync/pull', 'GET'], ['/sync/push', 'POST'], ['/auth/account', 'DELETE']] as const) {
            expect(await call(path, { method })).toMatchObject({ status: 401, json: { code: 'NOT_SIGNED_IN' } });
            expect(await call(path, { method, token: 'not.a.token' })).toMatchObject({ status: 401, json: { code: 'NOT_SIGNED_IN' } });
        }
    });

    it('refuse tokens signed with another secret, for another purpose, expired, or for a deleted account', async () => {
        const { sign } = await import('hono/jwt');
        const token = await account('shimi', '1');
        const user = await env.DB.prepare('SELECT id FROM users').first<{ id: number }>();
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const forged = await sign({ sub: String(user!.id), purpose: 'cloud-session', exp }, 'another-secret-another-secret-123456', 'HS256');
        const wrongPurpose = await sign({ sub: String(user!.id), purpose: 'something-else', exp }, env.JWT_SECRET!, 'HS256');
        const expired = await sign({ sub: String(user!.id), purpose: 'cloud-session', exp: Math.floor(Date.now() / 1000) - 10 }, env.JWT_SECRET!, 'HS256');
        const unsigned = `${btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: String(user!.id), purpose: 'cloud-session', exp }))}.`;
        for (const bad of [forged, wrongPurpose, expired, unsigned]) {
            expect((await call('/sync/pull', { token: bad })).status).toBe(401);
        }
        expect((await call('/sync/pull', { token })).status).toBe(200);

        // Deleting the account needs the password again, and ends the session.
        expect((await call('/auth/account', { method: 'DELETE', token, body: { authKey: keyFor('2') } })).status).toBe(401);
        expect((await call('/auth/account', { method: 'DELETE', token, body: { authKey: keyFor('1') } })).status).toBe(204);
        expect((await call('/sync/pull', { token })).status).toBe(401);
    });
});

describe('the entry module', () => {
    it('exports the handler and nothing else: the runtime reads every export as an entrypoint', async () => {
        // An extra export (a constant, say) passes every other test and then
        // fails to start under wrangler / on Cloudflare.
        const entry = await import('../src/index');
        expect(Object.keys(entry)).toEqual(['default']);
    });
});
