import { env } from 'cloudflare:workers';
import app from '../src/index';

export { env };

/** A sign-in key as a device would derive it from a password (64 hex characters). */
export const keyFor = (seed: string) => seed.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a');

export const DEVICE_A = 'device-aaaaaaaa';
export const DEVICE_B = 'device-bbbbbbbb';

type Options = { method?: string; body?: unknown; token?: string; raw?: string; env?: Partial<typeof env> };

/** Calls the Worker as a client would. */
export async function call(path: string, { method = 'GET', body, token, raw, env: override }: Options = {}) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const res = await app.request(path, { method, headers, body: payload }, { ...env, ...override });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
}

/** Creates an account and returns its session token. */
export async function account(username = 'shimi', seed = '1') {
    const res = await call('/auth/register', { method: 'POST', body: { username, authKey: keyFor(seed), registrationCode: 'let-me-in' } });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json.token as string;
}

export const change = (id: string, updatedAt: number, data: object | null = { name: id }, collection = 'playlists') =>
    (data === null ? { collection, id, updatedAt, deleted: true } : { collection, id, updatedAt, data });
