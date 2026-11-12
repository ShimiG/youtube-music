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
import { ApiError, type Env } from './types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_PURPOSE = 'google-oauth';
const STATE_MINUTES = 10;
const APP_RETURN = 'musicmanager://oauth';
const LOCAL_RETURN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

const READ_SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email'
];
const WRITE_SCOPE = 'https://www.googleapis.com/auth/youtube';

// Calls to Google go through here so tests can answer in Google's place.
export const outbound = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

function credentials(env: Env) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        throw new ApiError(503, 'GOOGLE_NOT_CONFIGURED', 'YouTube sign-in is not set up on the cloud service: its Google credentials are missing.');
    }
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

function secret(env: Env): string {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        throw new ApiError(503, 'NOT_CONFIGURED', 'The cloud service is not set up yet: its JWT_SECRET is missing or too short.');
    }
    return env.JWT_SECRET;
}

// The key for the stored refresh tokens: derived from JWT_SECRET, never stored.
async function tokenKey(env: Env): Promise<CryptoKey> {
    const material = await crypto.subtle.digest('SHA-256', encoder.encode(`music-manager-cloud:token-key:${secret(env)}`));
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env: Env, text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), encoder.encode(text));
    return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(sealed))}`;
}

async function unseal(env: Env, stored: string): Promise<string | null> {
    const [version, iv, sealed] = stored.split(':');
    if (version !== 'v1' || !iv || !sealed) return null;
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await tokenKey(env), fromBase64(sealed));
        return decoder.decode(plain);
    } catch {
        return null; // another key (JWT_SECRET was changed): the account must be connected again
    }
}

/** Where the browser may be sent after the consent page: the app, or this computer. */
function returnTarget(value: unknown): string {
    if (value === 'app') return APP_RETURN;
    if (typeof value === 'string' && LOCAL_RETURN.test(value)) return value;
    throw new ApiError(400, 'BAD_RETURN', 'returnTo must be "app" or an address on this computer (http://localhost:<port>).');
}

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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));

// Sends the browser back with the result. To the desktop app: a small page
// that opens the app's link (browsers ask before opening an app, and a page
// is clearer than a blank tab if the answer is no). To this computer: a plain
// redirect. With no known target: just the page.
function finish(target: string | null, ok: boolean, reason?: string): Response {
    const fragment = ok ? 'google=connected' : `google=error&reason=${reason ?? 'failed'}`;
    if (target && target !== APP_RETURN) {
        return new Response(null, { status: 302, headers: { Location: `${target}/#${fragment}`, 'Cache-Control': 'no-store' } });
    }
    const title = ok ? 'YouTube connected' : 'Connection failed';
    const text = ok ? 'You can close this tab and return to Music Manager.' : 'Something went wrong. Return to Music Manager and try again.';
    const link = target ? `${target}#${fragment}` : null;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${link ? `\n<meta http-equiv="refresh" content="0;url=${escapeHtml(link)}">` : ''}
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#121212;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}a{color:#1db954}</style>
</head><body><main><h1>${title}</h1><p>${text}</p>${link ? `<p><a href="${escapeHtml(link)}">Open Music Manager</a></p>` : ''}</main></body></html>`;
    return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
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
