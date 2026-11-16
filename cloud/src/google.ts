// YouTube (Google) sign-in, done by the Worker so that no computer holds the
// Google client secret and the account is connected once, for every computer.
//
//   POST   /google/start     { returnTo, scope? }  -> { url }: Google's consent page
//   GET    /google/callback  Google sends the browser back here
//   GET    /google/status    -> { configured, connected, scope }
//   POST   /google/token     -> { accessToken, expiresAt }: valid about an hour
//   DELETE /google           disconnect
//
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are Worker secrets. The refresh
// token Google issues is stored encrypted (AES-GCM) with a key derived from
// JWT_SECRET, so a copy of the database alone connects nobody. Devices get
// access tokens only.
//
// After the consent page, the browser is sent back to the app with nothing
// but a result ("connected" or "error") in the address: to the desktop app's
// own link, or to a page on the same computer. Never anywhere else.
import { sign, verify } from 'hono/jwt';
import { finish as finishPage, returnTarget, seal, secret, unseal } from './oauth';
import { ApiError, type Env } from './types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_PURPOSE = 'google-oauth';
const STATE_MINUTES = 10;

const READ_SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
];
const WRITE_SCOPE = 'https://www.googleapis.com/auth/youtube';

// Calls to Google go through here so tests can answer in Google's place.
export const outbound = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

function credentials(env: Env) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        throw new ApiError(503, 'GOOGLE_NOT_CONFIGURED', 'YouTube sign-in is not set up on the cloud service: its Google credentials are missing.');
    }
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

const finish = (target: string | null, ok: boolean, reason?: string) => finishPage('google', 'YouTube', target, ok, reason);

export async function status(env: Env, userId: number) {
    const row = await env.DB.prepare('SELECT scope FROM google_links WHERE user_id = ?').bind(userId).first<{ scope: string | null }>();
    return {
        configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        connected: Boolean(row),
        scope: row?.scope ?? null
    };
}

/** The address of Google's consent page for this account. */
export async function start(env: Env, userId: number, origin: string, body: unknown) {
    const { clientId } = credentials(env);
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    returnTarget(input.returnTo); // refuse a bad one now, not after the consent page
    // Google echoes `state` back untouched: it carries who asked and where
    // the browser goes afterwards ("app" or an address on this computer),
    // signed, so the callback can trust both. The callback checks it again.
    const state = await sign(
        { sub: String(userId), purpose: STATE_PURPOSE, ret: input.returnTo, exp: Math.floor(Date.now() / 1000) + STATE_MINUTES * 60 },
        secret(env),
        'HS256'
    );
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', `${origin}/google/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline'); // ask for a refresh token
    url.searchParams.set('prompt', 'consent'); // and get one every time
    url.searchParams.set('scope', [...READ_SCOPES, ...(input.scope === 'write' ? [WRITE_SCOPE] : [])].join(' '));
    url.searchParams.set('state', state);
    return { url: url.toString() };
}

/** Google sent the browser back: trade the code for tokens and keep the refresh token. */
export async function callback(env: Env, origin: string, query: { code?: string; state?: string; error?: string }): Promise<Response> {
    let userId: number;
    let target: string;
    try {
        const payload = await verify(query.state ?? '', secret(env), 'HS256');
        if (payload.purpose !== STATE_PURPOSE) throw new Error('wrong purpose');
        userId = Number(payload.sub);
        target = returnTarget(payload.ret);
        if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('bad subject');
    } catch {
        // Not a flow we started (or it took longer than ten minutes): there is
        // no trustworthy place to send the browser back to.
        return finish(null, false);
    }
    if (query.error || !query.code) return finish(target, false, 'denied');

    let tokens: { refresh_token?: string; scope?: string; error?: string };
    try {
        const { clientId, clientSecret } = credentials(env);
        const res = await outbound.fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code: query.code,
                grant_type: 'authorization_code',
                redirect_uri: `${origin}/google/callback`
            }).toString()
        });
        tokens = await res.json();
        if (!res.ok) throw new Error(tokens.error ?? `status ${res.status}`);
    } catch (err) {
        console.error('Google token exchange failed:', err instanceof Error ? err.message : err);
        return finish(target, false, 'token_exchange');
    }

    const user = await env.DB.prepare('SELECT 1 AS ok FROM users WHERE id = ?').bind(userId).first();
    if (!user) return finish(target, false, 'user_not_found');
    if (!tokens.refresh_token) {
        // Without one the connection would die within the hour.
        return finish(target, false, 'no_refresh_token');
    }
    await env.DB
        .prepare(
            `INSERT INTO google_links (user_id, refresh_token, scope, connected_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET refresh_token = excluded.refresh_token, scope = excluded.scope, connected_at = excluded.connected_at`
        )
        .bind(userId, await seal(env, tokens.refresh_token), tokens.scope ?? null, Date.now())
        .run();
    return finish(target, true);
}

/** A fresh access token for the account's YouTube connection. */
export async function accessToken(env: Env, userId: number) {
    const { clientId, clientSecret } = credentials(env);
    const row = await env.DB.prepare('SELECT refresh_token FROM google_links WHERE user_id = ?').bind(userId).first<{ refresh_token: string }>();
    const reconnect = new ApiError(409, 'GOOGLE_NOT_CONNECTED', 'YouTube is not connected for this account. Connect it again.');
    if (!row) throw reconnect;
    const refreshToken = await unseal(env, row.refresh_token);
    if (!refreshToken) {
        await env.DB.prepare('DELETE FROM google_links WHERE user_id = ?').bind(userId).run();
        throw reconnect;
    }
    let res: Response;
    let data: { access_token?: string; expires_in?: number; error?: string };
    try {
        res = await outbound.fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString()
        });
        data = await res.json();
    } catch {
        throw new ApiError(503, 'GOOGLE_UNREACHABLE', 'Google could not be reached. Try again in a moment.');
    }
    if (data.error === 'invalid_grant') {
        // The grant was revoked or has expired: the stored token is dead.
        await env.DB.prepare('DELETE FROM google_links WHERE user_id = ?').bind(userId).run();
        throw reconnect;
    }
    if (!res.ok || !data.access_token) {
        throw new ApiError(503, 'GOOGLE_UNREACHABLE', 'Google did not issue a token. Try again in a moment.');
    }
    return { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
}

/** Disconnects: asks Google to revoke the grant (best effort) and forgets it. */
export async function disconnect(env: Env, userId: number) {
    const row = await env.DB.prepare('SELECT refresh_token FROM google_links WHERE user_id = ?').bind(userId).first<{ refresh_token: string }>();
    await env.DB.prepare('DELETE FROM google_links WHERE user_id = ?').bind(userId).run();
    const refreshToken = row ? await unseal(env, row.refresh_token) : null;
    if (!refreshToken) return;
    try {
        await outbound.fetch(REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken }).toString()
        });
    } catch { /* already revoked, or Google unreachable: it is forgotten here either way */ }
}
