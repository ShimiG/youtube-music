// SoundCloud, done by the Worker so that no computer holds SoundCloud's client
// secret (the same arrangement as YouTube in google.ts).
//
//   POST   /soundcloud/start      { returnTo }  -> { url }: SoundCloud's consent page
//   GET    /soundcloud/callback   SoundCloud sends the browser back here
//   GET    /soundcloud/status     -> { configured, connected }
//   POST   /soundcloud/token      -> { accessToken, expiresAt }: this account's login
//   POST   /soundcloud/app-token  -> { accessToken, expiresAt }: the installation's own
//   DELETE /soundcloud            disconnect
//
// SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET are Worker secrets.
//
// Two tokens. An account that connects its SoundCloud login gets a token of
// its own (its playlists and likes). Search and playing public tracks use the
// "app" token, which belongs to the installation: SoundCloud hands out few of
// those (50 in 12 hours per app), so one is kept here and shared by every
// signed-in computer instead of each asking for its own.
//
// SoundCloud's refresh tokens work once. Two computers asking at the same
// moment must not both spend the same one: whoever loses that race is given
// the token the winner just stored, not an error (see renewed()).
import { sign, verify } from 'hono/jwt';
import { finish as finishPage, returnTarget, seal, secret, unseal } from './oauth';
import { ApiError, type Env } from './types';

const AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const SIGN_OUT_URL = 'https://secure.soundcloud.com/sign-out';
const STATE_PURPOSE = 'soundcloud-oauth';
const STATE_MINUTES = 10;
const APP_SERVICE = 'soundcloud';
// A token this close to its end is renewed, so a request never dies mid-way.
const EXPIRY_SKEW_MS = 60 * 1000;

// Calls to SoundCloud go through here so tests can answer in its place.
export const outbound = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

const finish = (target: string | null, ok: boolean, reason?: string) => finishPage('soundcloud', 'SoundCloud', target, ok, reason);

function credentials(env: Env) {
    if (!env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) {
        throw new ApiError(503, 'SOUNDCLOUD_NOT_CONFIGURED', 'SoundCloud is not set up on the cloud service: its SoundCloud credentials are missing.');
    }
    return { clientId: env.SOUNDCLOUD_CLIENT_ID, clientSecret: env.SOUNDCLOUD_CLIENT_SECRET };
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number };
type Stored = { access_token: string; refresh_token: string | null; expires_at: number };
// What a request to SoundCloud's token address came to.
type Issued = { ok: true; tokens: Tokens } | { ok: false; rejected: boolean; detail: string };

// One request to SoundCloud's token address. `rejected`: SoundCloud said no to
// what was sent (a spent refresh token, a wrong code); otherwise it could not
// be reached or failed on its side, and the same request may work later.
async function requestTokens(env: Env, form: Record<string, string>, { basic = false } = {}): Promise<Issued> {
    const { clientId, clientSecret } = credentials(env);
    const headers: Record<string, string> = { Accept: 'application/json; charset=utf-8', 'Content-Type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams(form);
    if (basic) {
        // The client_credentials grant only takes the credentials this way.
        headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    } else {
        body.set('client_id', clientId);
        body.set('client_secret', clientSecret);
    }
    let res: Response;
    let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
    try {
        res = await outbound.fetch(TOKEN_URL, { method: 'POST', headers, body: body.toString() });
        data = await res.json();
    } catch {
        return { ok: false, rejected: false, detail: 'unreachable' };
    }
    if (!res.ok || typeof data.access_token !== 'string') {
        const detail = typeof data.error === 'string' ? data.error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) : `status ${res.status}`;
        return { ok: false, rejected: res.status >= 400 && res.status < 500 && res.status !== 429, detail };
    }
    return {
        ok: true,
        tokens: {
            accessToken: data.access_token,
            refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
            expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000
        }
    };
}

const unreachable = () => new ApiError(503, 'SOUNDCLOUD_UNREACHABLE', 'SoundCloud could not be reached. Try again in a moment.');
const stillGood = (expiresAt: number) => expiresAt > Date.now() + EXPIRY_SKEW_MS;

async function sealed(env: Env, tokens: Tokens) {
    return {
        access: await seal(env, tokens.accessToken),
        refresh: tokens.refreshToken ? await seal(env, tokens.refreshToken) : null
    };
}

/**
 * The access token of a stored row, renewed when it is about to end.
 *
 * `read` gets the row; `write(previous, tokens)` stores new tokens in place of
 * `previous` (and only in its place: if the row changed meanwhile, the write
 * does nothing); `forget(previous)` removes a row whose tokens are dead.
 * Resolves to null when there is no usable row left (never connected, or its
 * refresh token is spent for good).
 */
async function renewed(
    env: Env,
    read: () => Promise<Stored | null>,
    write: (previous: Stored, tokens: Tokens) => Promise<void>,
    forget: (previous: Stored) => Promise<void>
): Promise<{ accessToken: string; expiresAt: number } | null> {
    const row = await read();
    if (!row) return null;
    const access = await unseal(env, row.access_token);
    if (access && stillGood(row.expires_at)) return { accessToken: access, expiresAt: row.expires_at };
    const refreshToken = row.refresh_token ? await unseal(env, row.refresh_token) : null;
    if (!refreshToken) {
        await forget(row);
        return null;
    }
    const issued = await requestTokens(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
    if (issued.ok) {
        await write(row, issued.tokens);
        return { accessToken: issued.tokens.accessToken, expiresAt: issued.tokens.expiresAt };
    }
    if (!issued.rejected) throw unreachable();
    // SoundCloud refused the refresh token. It works once, so the usual reason
    // is that another computer renewed a moment ago: then its tokens are in
    // the row by now, and they are what this caller gets.
    const now = await read();
    if (now && now.refresh_token !== row.refresh_token) {
        const theirs = await unseal(env, now.access_token);
        if (theirs && stillGood(now.expires_at)) return { accessToken: theirs, expiresAt: now.expires_at };
    }
    await forget(row);
    return null;
}

// --- An account's own SoundCloud login -------------------------------------------

export async function status(env: Env, userId: number) {
    const row = await env.DB.prepare('SELECT 1 AS ok FROM soundcloud_links WHERE user_id = ?').bind(userId).first();
    return {
        configured: Boolean(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET),
        connected: Boolean(row)
    };
}

/** The address of SoundCloud's consent page for this account. */
export async function start(env: Env, userId: number, origin: string, body: unknown) {
    const { clientId } = credentials(env);
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    returnTarget(env, input.returnTo); // refuse a bad one now, not after the consent page
    // PKCE: SoundCloud is shown a hash now and the value itself with the code
    // later. The value travels in `state`, through the browser, so it is
    // encrypted there; `state` as a whole is signed and says who asked and
    // where the browser goes afterwards.
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = await sign(
        { sub: String(userId), purpose: STATE_PURPOSE, ret: input.returnTo, v: await seal(env, verifier), exp: Math.floor(Date.now() / 1000) + STATE_MINUTES * 60 },
        secret(env),
        'HS256'
    );
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', `${origin}/soundcloud/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return { url: url.toString() };
}

/** SoundCloud sent the browser back: trade the code for tokens and keep them. */
export async function callback(env: Env, origin: string, query: { code?: string; state?: string; error?: string }): Promise<Response> {
    let userId: number;
    let target: string;
    let verifier: string | null;
    try {
        const payload = await verify(query.state ?? '', secret(env), 'HS256');
        if (payload.purpose !== STATE_PURPOSE) throw new Error('wrong purpose');
        userId = Number(payload.sub);
        target = returnTarget(env, payload.ret);
        verifier = typeof payload.v === 'string' ? await unseal(env, payload.v) : null;
        if (!Number.isSafeInteger(userId) || userId <= 0 || !verifier) throw new Error('bad state');
    } catch {
        // Not a flow we started (or it took longer than ten minutes): there is
        // no trustworthy place to send the browser back to.
        return finish(null, false);
    }
    if (query.error || !query.code) return finish(target, false, 'denied');

    let issued: Issued;
    try {
        issued = await requestTokens(env, {
            grant_type: 'authorization_code',
            redirect_uri: `${origin}/soundcloud/callback`,
            code_verifier: verifier,
            code: query.code
        });
    } catch {
        return finish(target, false, 'not_configured'); // the credentials were removed meanwhile
    }
    if (!issued.ok) {
        console.error('SoundCloud token exchange failed:', issued.detail);
        return finish(target, false, 'token_exchange');
    }

    const user = await env.DB.prepare('SELECT 1 AS ok FROM users WHERE id = ?').bind(userId).first();
    if (!user) return finish(target, false, 'user_not_found');
    const kept = await sealed(env, issued.tokens);
    await env.DB
        .prepare(
            `INSERT INTO soundcloud_links (user_id, access_token, refresh_token, expires_at, connected_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
                 expires_at = excluded.expires_at, connected_at = excluded.connected_at`
        )
        .bind(userId, kept.access, kept.refresh, issued.tokens.expiresAt, Date.now())
        .run();
    return finish(target, true);
}

/** A valid access token for the account's SoundCloud login. */
export async function accessToken(env: Env, userId: number) {
    credentials(env);
    const token = await renewed(
        env,
        () => env.DB.prepare('SELECT access_token, refresh_token, expires_at FROM soundcloud_links WHERE user_id = ?').bind(userId).first<Stored>(),
        async (previous, tokens) => {
            const kept = await sealed(env, tokens);
            await env.DB
                .prepare(
                    `UPDATE soundcloud_links SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?
                     WHERE user_id = ? AND access_token = ?`
                )
                .bind(kept.access, kept.refresh, tokens.expiresAt, userId, previous.access_token)
                .run();
        },
        async (previous) => {
            await env.DB.prepare('DELETE FROM soundcloud_links WHERE user_id = ? AND access_token = ?').bind(userId, previous.access_token).run();
        }
    );
    if (!token) throw new ApiError(409, 'SOUNDCLOUD_NOT_CONNECTED', 'SoundCloud is not connected for this account. Connect it again.');
    return token;
}

/** Disconnects: ends the session at SoundCloud (best effort) and forgets it. */
export async function disconnect(env: Env, userId: number) {
    const row = await env.DB.prepare('SELECT access_token FROM soundcloud_links WHERE user_id = ?').bind(userId).first<{ access_token: string }>();
    await env.DB.prepare('DELETE FROM soundcloud_links WHERE user_id = ?').bind(userId).run();
    const access = row ? await unseal(env, row.access_token) : null;
    if (!access) return;
    try {
        await outbound.fetch(SIGN_OUT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: access }) });
    } catch { /* already ended, or SoundCloud unreachable: it is forgotten here either way */ }
}

// --- The installation's token (search, public tracks) ----------------------------

/** A valid app token: the stored one, renewed, or a new one when there is none. */
export async function appToken(env: Env) {
    credentials(env);
    const read = () => env.DB.prepare('SELECT access_token, refresh_token, expires_at FROM service_tokens WHERE service = ?').bind(APP_SERVICE).first<Stored>();
    const kept = await renewed(
        env,
        read,
        async (previous, tokens) => {
            const next = await sealed(env, tokens);
            await env.DB
                .prepare(
                    `UPDATE service_tokens SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?
                     WHERE service = ? AND access_token = ?`
                )
                .bind(next.access, next.refresh, tokens.expiresAt, APP_SERVICE, previous.access_token)
                .run();
        },
        async (previous) => {
            await env.DB.prepare('DELETE FROM service_tokens WHERE service = ? AND access_token = ?').bind(APP_SERVICE, previous.access_token).run();
        }
    );
    if (kept) return kept;

    // None stored (or it could not be renewed): ask for a new one. This is
    // the request SoundCloud counts, which is why the answer is kept.
    const issued = await requestTokens(env, { grant_type: 'client_credentials' }, { basic: true });
    if (!issued.ok) {
        if (issued.rejected) {
            console.error('SoundCloud refused the app credentials:', issued.detail);
            throw new ApiError(503, 'SOUNDCLOUD_NOT_CONFIGURED', 'SoundCloud did not accept the credentials on the cloud service.');
        }
        throw unreachable();
    }
    const next = await sealed(env, issued.tokens);
    await env.DB
        .prepare(
            `INSERT INTO service_tokens (service, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (service) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
        )
        .bind(APP_SERVICE, next.access, next.refresh, issued.tokens.expiresAt)
        .run();
    return { accessToken: issued.tokens.accessToken, expiresAt: issued.tokens.expiresAt };
}
