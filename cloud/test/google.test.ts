import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import { outbound } from '../src/google';
import { account, call, env, keyFor } from './helpers';

// What "Google" was asked, and what it answers.
let asked: { url: string; body: URLSearchParams }[];
let answer: (url: string, body: URLSearchParams) => Response;
const realFetch = outbound.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    asked = [];
    answer = () => json({ access_token: 'ya29.access', expires_in: 3599, refresh_token: '1//refresh-token', scope: 'https://www.googleapis.com/auth/youtube.readonly' });
    outbound.fetch = async (input, init) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        asked.push({ url: input, body });
        return answer(input, body);
    };
});
afterEach(() => { outbound.fetch = realFetch; });

const ORIGIN = 'http://localhost'; // what the test requests are addressed to
const startFlow = async (token: string, returnTo: unknown = 'app', scope?: string) =>
    call('/google/start', { method: 'POST', token, body: { returnTo, scope } });
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const finishFlow = (state: string, extra = 'code=the-code') => call(`/google/callback?${extra}&state=${encodeURIComponent(state)}`);

describe('starting the YouTube sign-in', () => {
    it('needs a session and Google credentials on the service', async () => {
        expect((await call('/google/start', { method: 'POST', body: { returnTo: 'app' } })).status).toBe(401);
        const token = await account();
        expect(await call('/google/status', { token })).toMatchObject({ status: 200, json: { configured: true, connected: false, scope: null } });
        const unset = { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
        expect((await call('/google/status', { token, env: unset })).json.configured).toBe(false);
        expect(await call('/google/start', { method: 'POST', token, body: { returnTo: 'app' }, env: unset }))
            .toMatchObject({ status: 503, json: { code: 'GOOGLE_NOT_CONFIGURED' } });
    });

    it('sends the browser to Google with this service as the place to come back to, read-only unless asked', async () => {
        const token = await account();
        const res = await startFlow(token);
        expect(res.status).toBe(200);
        const url = new URL(res.json.url);
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            client_id: 'test-client-id.apps.googleusercontent.com',
            redirect_uri: `${ORIGIN}/google/callback`,
            response_type: 'code',
            access_type: 'offline',
            prompt: 'consent'
        });
        expect(url.searchParams.get('scope')).toContain('youtube.readonly');
        expect(url.searchParams.get('scope')).not.toMatch(/auth\/youtube( |$)/);
        expect(new URL((await startFlow(token, 'app', 'write')).json.url).searchParams.get('scope')).toMatch(/auth\/youtube( |$)/);
        // The client secret never goes to the browser.
        expect(res.json.url).not.toContain('test-google-client-secret');
    });

    it('only ever returns to the app or to this computer', async () => {
        const token = await account();
        for (const ok of ['app', 'http://localhost:5173', 'http://127.0.0.1:1420', 'http://localhost']) {
            expect((await startFlow(token, ok)).status).toBe(200);
        }
        expect(await call('/google/start', { method: 'POST', token, body: {} })).toMatchObject({ status: 400, json: { code: 'BAD_RETURN' } });
        for (const bad of ['', 'web', 'https://evil.example', 'http://localhost:5173/path', 'http://localhost.evil.example', 'http://192.168.1.5:5173', 'musicmanager://oauth', 'javascript:alert(1)', ['app']]) {
            expect(await startFlow(token, bad)).toMatchObject({ status: 400, json: { code: 'BAD_RETURN' } });
        }
    });
});

describe('coming back from Google', () => {
    it('stores the refresh token encrypted and sends the app a bare "connected"', async () => {
        const token = await account();
        const state = stateOf((await startFlow(token, 'app')).json.url);
        const res = await call(`/google/callback?code=the-code&state=${encodeURIComponent(state)}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/html');

        // What was sent to Google: the code, with the secret, server to server.
        expect(asked).toHaveLength(1);
        expect(asked[0]!.url).toBe('https://oauth2.googleapis.com/token');
        expect(Object.fromEntries(asked[0]!.body)).toEqual({
            client_id: 'test-client-id.apps.googleusercontent.com',
            client_secret: 'test-google-client-secret',
            code: 'the-code',
            grant_type: 'authorization_code',
            redirect_uri: `${ORIGIN}/google/callback`
        });

        const row = await env.DB.prepare('SELECT refresh_token, scope FROM google_links').first<{ refresh_token: string; scope: string }>();
        expect(row!.refresh_token).toMatch(/^v1:/);
        expect(row!.refresh_token).not.toContain('1//refresh-token');
        expect(await call('/google/status', { token })).toMatchObject({ json: { connected: true, scope: 'https://www.googleapis.com/auth/youtube.readonly' } });
    });

    it('the page it shows opens the app with the result and nothing else', async () => {
        const token = await account();
        const state = stateOf((await startFlow(token, 'app')).json.url);
        const { default: app } = await import('../src/index');
        const res = await app.request(`/google/callback?code=c&state=${encodeURIComponent(state)}`, {}, env);
        const html = await res.text();
        expect(html).toContain('url=musicmanager://oauth#google=connected');
        expect(html).toContain('YouTube connected');
        expect(html).not.toMatch(/refresh-token|ya29|the-code/);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('returns to a page on this computer with a redirect when that is where the flow started', async () => {
        const token = await account();
        const state = stateOf((await startFlow(token, 'http://localhost:5173')).json.url);
        const res = await finishFlow(state);
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('http://localhost:5173/#google=connected');
    });

    it('refuses a state it did not sign, one for another purpose, and an expired one, without calling Google', async () => {
        const token = await account();
        const user = await env.DB.prepare('SELECT id FROM users').first<{ id: number }>();
        const exp = Math.floor(Date.now() / 1000) + 600;
        const forged = await sign({ sub: String(user!.id), purpose: 'google-oauth', ret: 'musicmanager://oauth', exp }, 'another-secret-another-secret-123456', 'HS256');
        // A session token is signed with the same secret: it must not pass as a state.
        const expired = await sign({ sub: String(user!.id), purpose: 'google-oauth', ret: 'musicmanager://oauth', exp: exp - 1200 }, env.JWT_SECRET!, 'HS256');
        const elsewhere = await sign({ sub: String(user!.id), purpose: 'google-oauth', ret: 'https://evil.example', exp }, env.JWT_SECRET!, 'HS256');
        for (const state of ['', 'garbage', forged, token, expired, elsewhere]) {
            const res = await finishFlow(state);
            expect(res.status).toBe(400);
            expect(res.headers.get('Location')).toBeNull();
        }
        expect(asked).toHaveLength(0);
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM google_links').first()).toEqual({ n: 0 });
    });

    it('reports a refusal at Google, a failed exchange and a missing refresh token as errors, and stores nothing', async () => {
        const token = await account();
        const fresh = async () => stateOf((await startFlow(token, 'http://localhost:5173')).json.url);
        expect((await finishFlow(await fresh(), 'error=access_denied')).headers.get('Location')).toBe('http://localhost:5173/#google=error&reason=denied');
        answer = () => json({ error: 'invalid_grant' }, 400);
        expect((await finishFlow(await fresh())).headers.get('Location')).toBe('http://localhost:5173/#google=error&reason=token_exchange');
        answer = () => json({ access_token: 'ya29.access', expires_in: 3599 });
        expect((await finishFlow(await fresh())).headers.get('Location')).toBe('http://localhost:5173/#google=error&reason=no_refresh_token');
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM google_links').first()).toEqual({ n: 0 });
    });
});

describe('using the connection', () => {
    const connect = async (name = 'shimi', seed = '1') => {
        const token = await account(name, seed);
        await finishFlow(stateOf((await startFlow(token, 'app')).json.url));
        asked.length = 0;
        return token;
    };

    it('hands a device a short-lived access token, never the refresh token', async () => {
        const token = await connect();
        answer = () => json({ access_token: 'ya29.fresh', expires_in: 3599 });
        const res = await call('/google/token', { method: 'POST', token });
        expect(res.status).toBe(200);
        expect(res.json.accessToken).toBe('ya29.fresh');
        expect(res.json.expiresAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
        expect(JSON.stringify(res.json)).not.toContain('refresh');
        expect(Object.fromEntries(asked[0]!.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: '1//refresh-token', client_secret: 'test-google-client-secret' });
    });

    it('is per account, and needs a session', async () => {
        const mine = await connect('shimi', '1');
        const theirs = await account('other', '2');
        expect((await call('/google/token', { method: 'POST' })).status).toBe(401);
        expect(await call('/google/token', { method: 'POST', token: theirs })).toMatchObject({ status: 409, json: { code: 'GOOGLE_NOT_CONNECTED' } });
        expect((await call('/google/status', { token: theirs })).json.connected).toBe(false);
        expect((await call('/google/token', { method: 'POST', token: mine })).status).toBe(200);
    });

    it('forgets a connection Google has revoked, and says to connect again', async () => {
        const token = await connect();
        answer = () => json({ error: 'invalid_grant' }, 400);
        expect(await call('/google/token', { method: 'POST', token })).toMatchObject({ status: 409, json: { code: 'GOOGLE_NOT_CONNECTED' } });
        expect((await call('/google/status', { token })).json.connected).toBe(false);
    });

    it('keeps the connection when Google is merely unreachable or busy', async () => {
        const token = await connect();
        answer = () => json({ error: 'backend_error' }, 503);
        expect(await call('/google/token', { method: 'POST', token })).toMatchObject({ status: 503, json: { code: 'GOOGLE_UNREACHABLE' } });
        answer = () => { throw new Error('network'); };
        expect((await call('/google/token', { method: 'POST', token })).status).toBe(503);
        expect((await call('/google/status', { token })).json.connected).toBe(true);
    });

    it('a stored token cannot be read with another JWT_SECRET: the account is simply asked to connect again', async () => {
        const token = await connect();
        const other = { JWT_SECRET: 'another-secret-another-secret-123456' };
        const session = (await call('/auth/login', { method: 'POST', body: { username: 'shimi', authKey: keyFor('1') }, env: other })).json.token;
        expect(await call('/google/token', { method: 'POST', token: session, env: other })).toMatchObject({ status: 409, json: { code: 'GOOGLE_NOT_CONNECTED' } });
        void token;
    });

    it('disconnecting revokes at Google and forgets; deleting the account forgets too', async () => {
        const token = await connect();
        expect((await call('/google', { method: 'DELETE', token })).status).toBe(204);
        expect(asked[0]!.url).toBe('https://oauth2.googleapis.com/revoke');
        expect(asked[0]!.body.get('token')).toBe('1//refresh-token');
        expect((await call('/google/status', { token })).json.connected).toBe(false);

        const again = await connect('second', '2');
        expect((await call('/auth/account', { method: 'DELETE', token: again, body: { authKey: keyFor('2') } })).status).toBe(204);
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM google_links').first()).toEqual({ n: 0 });
    });
});
