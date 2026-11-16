import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outbound } from '../src/soundcloud';
import { seal } from '../src/oauth';
import { account, call, env } from './helpers';

// What "SoundCloud" was asked, and what it answers.
let asked: { url: string; body: URLSearchParams; headers: Record<string, string> }[];
let answer: (url: string, body: URLSearchParams) => Response | Promise<Response>;
const realFetch = outbound.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let issuedCount: number;
const issue = () => { issuedCount += 1; return json({ access_token: `access-${issuedCount}`, refresh_token: `refresh-${issuedCount}`, expires_in: 3600 }); };

beforeEach(() => {
    asked = [];
    issuedCount = 0;
    answer = () => issue();
    outbound.fetch = async (input, init) => {
        const body = new URLSearchParams(typeof init?.body === 'string' && !init.body.startsWith('{') ? init.body : '');
        asked.push({ url: input, body, headers: (init?.headers ?? {}) as Record<string, string> });
        return answer(input, body);
    };
});
afterEach(() => { outbound.fetch = realFetch; });

const ORIGIN = 'http://localhost'; // what the test requests are addressed to
const startFlow = (token: string, returnTo: unknown = 'app') => call('/soundcloud/start', { method: 'POST', token, body: { returnTo } });
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const connect = async (token: string) => {
    const state = stateOf((await startFlow(token)).json.url);
    return call(`/soundcloud/callback?code=the-code&state=${encodeURIComponent(state)}`);
};
const link = () => env.DB.prepare('SELECT * FROM soundcloud_links').first<Record<string, any>>();
const appRow = () => env.DB.prepare(`SELECT * FROM service_tokens WHERE service = 'soundcloud'`).first<Record<string, any>>();
const unset = { SOUNDCLOUD_CLIENT_ID: undefined, SOUNDCLOUD_CLIENT_SECRET: undefined };
const sha256url = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('starting the SoundCloud sign-in', () => {
    it('needs a session and SoundCloud credentials on the service', async () => {
        expect((await call('/soundcloud/start', { method: 'POST', body: { returnTo: 'app' } })).status).toBe(401);
        const token = await account();
        expect(await call('/soundcloud/status', { token })).toMatchObject({ status: 200, json: { configured: true, connected: false } });
        expect((await call('/soundcloud/status', { token, env: unset })).json.configured).toBe(false);
        expect(await call('/soundcloud/start', { method: 'POST', token, body: { returnTo: 'app' }, env: unset }))
            .toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_NOT_CONFIGURED' } });
    });

    it('sends the browser to SoundCloud with this service as the place to come back to, and a challenge', async () => {
        const token = await account();
        const res = await startFlow(token);
        expect(res.status).toBe(200);
        const url = new URL(res.json.url);
        expect(url.origin + url.pathname).toBe('https://secure.soundcloud.com/authorize');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            client_id: 'test-soundcloud-client-id',
            redirect_uri: `${ORIGIN}/soundcloud/callback`,
            response_type: 'code',
            code_challenge_method: 'S256'
        });
        expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // The client secret never goes to the browser.
        expect(res.json.url).not.toContain('test-soundcloud-client-secret');
    });

    it('only ever returns to the app or to this computer', async () => {
        const token = await account();
        for (const ok of ['app', 'http://localhost:5173', 'http://127.0.0.1:1420']) expect((await startFlow(token, ok)).status).toBe(200);
        for (const bad of ['', 'web', 'https://evil.example', 'http://localhost:5173/path', 'http://192.168.1.5:5173', 'musicmanager://oauth', ['app']]) {
            expect(await startFlow(token, bad)).toMatchObject({ status: 400, json: { code: 'BAD_RETURN' } });
        }
    });
});

describe('coming back from SoundCloud', () => {
    it('trades the code with the secret and the value behind the challenge, and stores the tokens encrypted', async () => {
        const token = await account();
        const started = await startFlow(token);
        const challenge = new URL(started.json.url).searchParams.get('code_challenge');
        const state = stateOf(started.json.url);
        const res = await call(`/soundcloud/callback?code=the-code&state=${encodeURIComponent(state)}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/html');

        expect(asked).toHaveLength(1);
        expect(asked[0]!.url).toBe('https://secure.soundcloud.com/oauth/token');
        expect(Object.fromEntries(asked[0]!.body)).toMatchObject({
            grant_type: 'authorization_code',
            code: 'the-code',
            redirect_uri: `${ORIGIN}/soundcloud/callback`,
            client_id: 'test-soundcloud-client-id',
            client_secret: 'test-soundcloud-client-secret'
        });
        // The value shown to SoundCloud now is the one whose hash it was shown before,
        // and it did not travel through the browser in the clear.
        const verifier = asked[0]!.body.get('code_verifier')!;
        expect(await sha256url(verifier)).toBe(challenge);
        expect(atob(state.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain(verifier);

        const row = await link();
        expect(row!.access_token).toMatch(/^v1:/);
        expect(row!.refresh_token).toMatch(/^v1:/);
        expect(JSON.stringify(row)).not.toMatch(/access-1|refresh-1/);
        expect((await call('/soundcloud/status', { token })).json.connected).toBe(true);
    });

    it('redirects to this computer when the flow started there, with nothing but the result', async () => {
        const token = await account();
        const state = stateOf((await startFlow(token, 'http://localhost:5173')).json.url);
        const res = await call(`/soundcloud/callback?code=c&state=${encodeURIComponent(state)}`);
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe('http://localhost:5173/#soundcloud=connected');
    });

    it('accepts no state it did not issue, and connects nothing when the user or SoundCloud says no', async () => {
        const token = await account();
        const googleState = stateOf((await call('/google/start', { method: 'POST', token, body: { returnTo: 'app' } })).json.url);
        for (const state of ['', 'nonsense', googleState]) {
            expect((await call(`/soundcloud/callback?code=c&state=${encodeURIComponent(state)}`)).status).toBe(400);
        }
        expect(asked).toHaveLength(0);

        const state = stateOf((await startFlow(token, 'http://localhost:5173')).json.url);
        const denied = await call(`/soundcloud/callback?error=access_denied&state=${encodeURIComponent(state)}`);
        expect(denied.headers.get('Location')).toBe('http://localhost:5173/#soundcloud=error&reason=denied');

        answer = () => json({ error: 'invalid_grant' }, 400);
        const refused = await call(`/soundcloud/callback?code=c&state=${encodeURIComponent(state)}`);
        expect(refused.headers.get('Location')).toBe('http://localhost:5173/#soundcloud=error&reason=token_exchange');
        expect(await link()).toBeNull();
    });
});

describe("an account's SoundCloud token", () => {
    it('needs a session and a connection', async () => {
        expect((await call('/soundcloud/token', { method: 'POST' })).status).toBe(401);
        const token = await account();
        expect(await call('/soundcloud/token', { method: 'POST', token })).toMatchObject({ status: 409, json: { code: 'SOUNDCLOUD_NOT_CONNECTED' } });
        expect(await call('/soundcloud/token', { method: 'POST', token, env: unset })).toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_NOT_CONFIGURED' } });
    });

    it('hands out the stored token while it is good, without asking SoundCloud again', async () => {
        const token = await account();
        await connect(token);
        asked = [];
        const res = await call('/soundcloud/token', { method: 'POST', token });
        expect(res).toMatchObject({ status: 200, json: { accessToken: 'access-1' } });
        expect(res.json.expiresAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
        expect(res.json).not.toHaveProperty('refreshToken');
        expect(asked).toHaveLength(0);
    });

    it('renews a token that is about to end, and keeps the new refresh token (the old one works once)', async () => {
        const token = await account();
        await connect(token);
        await env.DB.prepare('UPDATE soundcloud_links SET expires_at = ?').bind(Date.now() + 30 * 1000).run();
        asked = [];
        const res = await call('/soundcloud/token', { method: 'POST', token });
        expect(res).toMatchObject({ status: 200, json: { accessToken: 'access-2' } });
        expect(Object.fromEntries(asked[0]!.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_secret: 'test-soundcloud-client-secret' });

        // The next renewal uses the refresh token that came with this one.
        await env.DB.prepare('UPDATE soundcloud_links SET expires_at = ?').bind(Date.now() - 1000).run();
        asked = [];
        expect((await call('/soundcloud/token', { method: 'POST', token })).json.accessToken).toBe('access-3');
        expect(asked[0]!.body.get('refresh_token')).toBe('refresh-2');
    });

    it('gives the loser of a race the token the winner stored, instead of disconnecting the account', async () => {
        const token = await account();
        await connect(token);
        await env.DB.prepare('UPDATE soundcloud_links SET expires_at = ?').bind(Date.now() - 1000).run();
        // Another computer renews first: by the time SoundCloud refuses our
        // (now spent) refresh token, the row holds that computer's tokens.
        answer = async () => {
            await env.DB.prepare('UPDATE soundcloud_links SET access_token = ?, refresh_token = ?, expires_at = ?')
                .bind(await seal(env, 'access-from-the-other-computer'), await seal(env, 'refresh-from-the-other-computer'), Date.now() + 3600 * 1000).run();
            return json({ error: 'invalid_grant' }, 400);
        };
        const res = await call('/soundcloud/token', { method: 'POST', token });
        expect(res).toMatchObject({ status: 200, json: { accessToken: 'access-from-the-other-computer' } });
        expect(await link()).not.toBeNull();
    });

    it('forgets a login whose refresh token is dead, and keeps one that only could not be renewed just now', async () => {
        const token = await account();
        await connect(token);
        await env.DB.prepare('UPDATE soundcloud_links SET expires_at = ?').bind(Date.now() - 1000).run();

        answer = () => json({ error: 'temporarily_unavailable' }, 503);
        expect(await call('/soundcloud/token', { method: 'POST', token })).toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_UNREACHABLE' } });
        answer = () => { throw new Error('network down'); };
        expect(await call('/soundcloud/token', { method: 'POST', token })).toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_UNREACHABLE' } });
        answer = () => json({ error: 'rate_limited' }, 429);
        expect((await call('/soundcloud/token', { method: 'POST', token })).status).toBe(503);
        expect(await link()).not.toBeNull();

        answer = () => json({ error: 'invalid_grant' }, 400);
        expect(await call('/soundcloud/token', { method: 'POST', token })).toMatchObject({ status: 409, json: { code: 'SOUNDCLOUD_NOT_CONNECTED' } });
        expect(await link()).toBeNull();
        expect((await call('/soundcloud/status', { token })).json.connected).toBe(false);
    });

    it("is one account's: another account is not connected by it", async () => {
        const first = await account('first', '1');
        const second = await account('second', '2');
        await connect(first);
        expect((await call('/soundcloud/token', { method: 'POST', token: second })).status).toBe(409);
        expect((await call('/soundcloud/status', { token: second })).json.connected).toBe(false);
    });

    it('disconnects: ends the session at SoundCloud and forgets the tokens', async () => {
        const token = await account();
        await connect(token);
        asked = [];
        expect((await call('/soundcloud', { method: 'DELETE', token })).status).toBe(204);
        expect(asked[0]!.url).toBe('https://secure.soundcloud.com/sign-out');
        expect(await link()).toBeNull();
        // Again, with nothing to disconnect, and with SoundCloud unreachable: still fine.
        answer = () => { throw new Error('down'); };
        expect((await call('/soundcloud', { method: 'DELETE', token })).status).toBe(204);
    });
});

describe("the installation's SoundCloud token (search, public tracks)", () => {
    it('needs a session and credentials', async () => {
        expect((await call('/soundcloud/app-token', { method: 'POST' })).status).toBe(401);
        const token = await account();
        expect(await call('/soundcloud/app-token', { method: 'POST', token, env: unset })).toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_NOT_CONFIGURED' } });
        expect(asked).toHaveLength(0);
    });

    it('asks SoundCloud once and shares the answer with every signed-in computer', async () => {
        const first = await account('first', '1');
        const second = await account('second', '2');
        const res = await call('/soundcloud/app-token', { method: 'POST', token: first });
        expect(res).toMatchObject({ status: 200, json: { accessToken: 'access-1' } });
        expect(asked).toHaveLength(1);
        expect(asked[0]!.body.get('grant_type')).toBe('client_credentials');
        // This grant takes the credentials in the Authorization header only.
        expect(asked[0]!.headers.Authorization).toBe(`Basic ${btoa('test-soundcloud-client-id:test-soundcloud-client-secret')}`);
        expect(asked[0]!.body.get('client_secret')).toBeNull();

        expect((await call('/soundcloud/app-token', { method: 'POST', token: second })).json.accessToken).toBe('access-1');
        expect((await call('/soundcloud/app-token', { method: 'POST', token: first })).json.accessToken).toBe('access-1');
        expect(asked).toHaveLength(1);
        const row = await appRow();
        expect(row!.access_token).toMatch(/^v1:/);
        expect(JSON.stringify(row)).not.toContain('access-1');
    });

    it('renews it with its refresh token, and asks for a new one only when that fails', async () => {
        const token = await account();
        await call('/soundcloud/app-token', { method: 'POST', token });
        await env.DB.prepare('UPDATE service_tokens SET expires_at = ?').bind(Date.now() - 1000).run();
        asked = [];
        expect((await call('/soundcloud/app-token', { method: 'POST', token })).json.accessToken).toBe('access-2');
        expect(asked.map((a) => a.body.get('grant_type'))).toEqual(['refresh_token']);
        expect(asked[0]!.body.get('refresh_token')).toBe('refresh-1');

        // The refresh token is refused: one new client_credentials request.
        await env.DB.prepare('UPDATE service_tokens SET expires_at = ?').bind(Date.now() - 1000).run();
        asked = [];
        answer = (_url, body) => (body.get('grant_type') === 'refresh_token' ? json({ error: 'invalid_grant' }, 400) : issue());
        expect((await call('/soundcloud/app-token', { method: 'POST', token })).json.accessToken).toBe('access-3');
        expect(asked.map((a) => a.body.get('grant_type'))).toEqual(['refresh_token', 'client_credentials']);
        expect((await call('/soundcloud/app-token', { method: 'POST', token })).json.accessToken).toBe('access-3');
        expect(asked).toHaveLength(2);
    });

    it('says which it is when SoundCloud refuses the credentials or cannot be reached', async () => {
        const token = await account();
        answer = () => json({ error: 'invalid_client' }, 401);
        expect(await call('/soundcloud/app-token', { method: 'POST', token })).toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_NOT_CONFIGURED' } });
        answer = () => json({ error: 'rate_limited' }, 429);
        expect(await call('/soundcloud/app-token', { method: 'POST', token })).toMatchObject({ status: 503, json: { code: 'SOUNDCLOUD_UNREACHABLE' } });
        expect(await appRow()).toBeNull();
    });
});

describe('what the services are set up with', () => {
    it('tells a signed-in computer which sign-ins the service can do, and never a secret', async () => {
        expect((await call('/services')).status).toBe(401);
        const token = await account();
        const res = await call('/services', { token });
        expect(res).toMatchObject({ status: 200, json: { google: { configured: true }, soundcloud: { configured: true }, audius: { apiKey: 'test-audius-key' } } });
        const text = JSON.stringify(res.json);
        expect(text).not.toMatch(/client-secret|test-secret|test-pepper|let-me-in|client-id/);
        const bare = await call('/services', { token, env: { ...unset, GOOGLE_CLIENT_ID: undefined, AUDIUS_API_KEY: undefined } });
        expect(bare.json).toEqual({ google: { configured: false }, soundcloud: { configured: false }, audius: { apiKey: null } });
    });
});
