// Accounts and sessions.
//
// The free Workers plan allows 10 ms of processor time per request, far too
// little to stretch a password properly. So the stretching happens on the
// device: it turns the password into a 32-byte key with scrypt (salted with
// the user name) and sends that key. The password itself never leaves the
// device. Here the key is treated like a long random password: only a hash of
// it is stored (with an optional server-side pepper), and comparisons take
// the same time whatever the input.
//
// A session is a signed token (HS256) valid for 30 days.
import { sign, verify } from 'hono/jwt';
import type { MiddlewareHandler } from 'hono';
import { ApiError, type AppEnv, type Env } from './types';

const SESSION_DAYS = 30;
const TOKEN_PURPOSE = 'cloud-session';
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;
const AUTH_KEY = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings in time that does not depend on where they differ. */
async function sameSecret(a: string, b: string): Promise<boolean> {
    // Hash both first: equal lengths, and the inputs themselves are never
    // compared byte by byte.
    const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

const authHash = (env: Env, authKey: string) => sha256Hex(`${env.AUTH_PEPPER ?? ''}:${authKey}`);

function jwtSecret(env: Env): string {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        throw new ApiError(503, 'NOT_CONFIGURED', 'The cloud service is not set up yet: its JWT_SECRET is missing or too short.');
    }
    return env.JWT_SECRET;
}

async function newSession(env: Env, userId: number) {
    const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
    const token = await sign({ sub: String(userId), purpose: TOKEN_PURPOSE, exp: Math.floor(expiresAt / 1000) }, jwtSecret(env), 'HS256');
    return { token, expiresAt, userId };
}

function credentials(body: unknown): { username: string; authKey: string } {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const authKey = typeof input.authKey === 'string' ? input.authKey : '';
    if (!USERNAME.test(username)) {
        throw new ApiError(400, 'BAD_USERNAME', 'A user name is 3 to 32 letters, digits, dots, dashes or underscores.');
    }
    if (!AUTH_KEY.test(authKey)) {
        throw new ApiError(400, 'BAD_AUTH_KEY', 'The sign-in key must be 64 hexadecimal characters.');
    }
    return { username, authKey };
}

/** Creates an account. Only for callers who know the registration code. */
export async function register(env: Env, body: unknown) {
    const secret = jwtSecret(env); // fail before writing anything
    void secret;
    const { username, authKey } = credentials(body);
    const code = typeof (body as Record<string, unknown>).registrationCode === 'string'
        ? (body as Record<string, string>).registrationCode
        : '';
    if (!env.REGISTRATION_CODE) {
        throw new ApiError(403, 'REGISTRATION_CLOSED', 'Creating accounts is turned off on this service.');
    }
    if (!(await sameSecret(code ?? '', env.REGISTRATION_CODE))) {
        throw new ApiError(403, 'BAD_REGISTRATION_CODE', 'That registration code is not right.');
    }
    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (existing) throw new ApiError(409, 'USERNAME_TAKEN', 'That user name is already in use.');
    const row = await env.DB
        .prepare('INSERT INTO users (username, auth_hash, created_at) VALUES (?, ?, ?) RETURNING id')
        .bind(username, await authHash(env, authKey), Date.now())
        .first<{ id: number }>();
    if (!row) throw new ApiError(500, 'INTERNAL', 'The account could not be created.');
    return newSession(env, row.id);
}

/** Signs in. Wrong name and wrong key give the same answer. */
export async function login(env: Env, body: unknown) {
    const secret = jwtSecret(env);
    void secret;
    const { username, authKey } = credentials(body);
    const user = await env.DB
        .prepare('SELECT id, auth_hash, failed_logins, locked_until FROM users WHERE username = ?')
        .bind(username)
        .first<{ id: number; auth_hash: string; failed_logins: number; locked_until: number }>();

    const offered = await authHash(env, authKey);
    // Compare even when there is no such user, so the answer takes as long.
    const matches = await sameSecret(offered, user ? user.auth_hash : 'no-such-user');
    const denied = new ApiError(401, 'BAD_CREDENTIALS', 'Wrong user name or password.');
    if (!user) throw denied;

    const now = Date.now();
    if (user.locked_until > now) {
        throw new ApiError(423, 'LOCKED', 'Too many failed sign-ins. Try again in a few minutes.');
    }
    if (!matches) {
        const failures = user.failed_logins + 1;
        const lockedUntil = failures >= MAX_FAILED_LOGINS ? now + LOCK_MINUTES * 60 * 1000 : 0;
        await env.DB
            .prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
            .bind(lockedUntil ? 0 : failures, lockedUntil, user.id)
            .run();
        throw denied;
    }
    if (user.failed_logins > 0) {
        await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').bind(user.id).run();
    }
    return newSession(env, user.id);
}

/** Deletes the caller's account and everything synced under it. */
export async function deleteAccount(env: Env, userId: number, body: unknown) {
    const authKey = typeof (body as Record<string, unknown> | null)?.authKey === 'string' ? (body as Record<string, string>).authKey ?? '' : '';
    const user = await env.DB.prepare('SELECT auth_hash FROM users WHERE id = ?').bind(userId).first<{ auth_hash: string }>();
    if (!user || !AUTH_KEY.test(authKey) || !(await sameSecret(await authHash(env, authKey), user.auth_hash))) {
        throw new ApiError(401, 'BAD_CREDENTIALS', 'Confirm with your password to delete the account.');
    }
    // Two statements, one transaction: D1 does not enforce ON DELETE CASCADE
    // unless foreign keys are on for the connection, so do not rely on it.
    await env.DB.batch([
        env.DB.prepare('DELETE FROM records WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)
    ]);
}

/** Lets a request through only with a valid session token of an existing account. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const denied = new ApiError(401, 'NOT_SIGNED_IN', 'Sign in to the cloud account first.');
    if (!token) throw denied;
    let userId: number;
    try {
        const payload = await verify(token, jwtSecret(c.env), 'HS256');
        if (payload.purpose !== TOKEN_PURPOSE) throw new Error('wrong purpose');
        userId = Number(payload.sub);
        if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('bad subject');
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw denied;
    }
    // A token for a deleted account is worthless.
    const exists = await c.env.DB.prepare('SELECT 1 AS ok FROM users WHERE id = ?').bind(userId).first();
    if (!exists) throw denied;
    c.set('userId', userId);
    await next();
};
