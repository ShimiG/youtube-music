// What the sign-ins done by the Worker have in common (YouTube in google.ts,
// SoundCloud in soundcloud.ts): the key that protects stored tokens, where a
// browser may be sent after a consent page, and the page that sends it there.
import { ApiError, type Env } from './types';

const APP_RETURN = 'musicmanager://oauth';
const LOCAL_RETURN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

export function secret(env: Env): string {
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        throw new ApiError(503, 'NOT_CONFIGURED', 'The cloud service is not set up yet: its JWT_SECRET is missing or too short.');
    }
    return env.JWT_SECRET;
}

// The key for the stored tokens: derived from JWT_SECRET, never stored.
async function tokenKey(env: Env): Promise<CryptoKey> {
    const material = await crypto.subtle.digest('SHA-256', encoder.encode(`music-manager-cloud:token-key:${secret(env)}`));
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypts a token for the database (AES-GCM): a copy of the database alone is of no use. */
export async function seal(env: Env, text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(env), encoder.encode(text));
    return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(sealed))}`;
}

/** The token again, or null when it was sealed with another key (JWT_SECRET was changed). */
export async function unseal(env: Env, stored: string): Promise<string | null> {
    const [version, iv, sealed] = stored.split(':');
    if (version !== 'v1' || !iv || !sealed) return null;
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await tokenKey(env), fromBase64(sealed));
        return decoder.decode(plain);
    } catch {
        return null;
    }
}

// The websites the owner runs Music Manager on (docs/deploy-render.md):
// WEB_ORIGINS, comma-separated https addresses. What is pasted is forgiven
// where it does not change the meaning: a trailing slash or a path (only the
// site counts), quotes, spaces, upper case. What is not https is left out.
export function webOrigins(env: Env): Set<string> {
    const origins = new Set<string>();
    for (const raw of String(env.WEB_ORIGINS ?? '').split(/[,\s]+/)) {
        const value = raw.trim().replace(/^["']+|["']+$/g, '');
        if (!value) continue;
        try {
            const url = new URL(value);
            if (url.protocol === 'https:' && !url.username && !url.password) origins.add(url.origin.toLowerCase());
        } catch { /* not an address: left out */ }
    }
    return origins;
}

/**
 * Where the browser may be sent after the consent page: the app, this
 * computer, or one of the owner's own websites (WEB_ORIGINS). Nowhere else.
 */
export function returnTarget(env: Env, value: unknown): string {
    if (value === 'app') return APP_RETURN;
    if (typeof value === 'string' && LOCAL_RETURN.test(value)) return value;
    if (typeof value === 'string' && webOrigins(env).has(value.toLowerCase())) return value.toLowerCase();
    throw new ApiError(400, 'BAD_RETURN', 'returnTo must be "app", an address on this computer (http://localhost:<port>), or a site listed in WEB_ORIGINS.');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));

// Sends the browser back with the result. To the desktop app: a small page
// that opens the app's link (browsers ask before opening an app, and a page
// is clearer than a blank tab if the answer is no). To this computer: a plain
// redirect. With no known target: just the page.
// `service` names the result in the address ("google=connected"); `label` is
// what the page calls it ("YouTube").
export function finish(service: string, label: string, target: string | null, ok: boolean, reason?: string): Response {
    const fragment = ok ? `${service}=connected` : `${service}=error&reason=${reason ?? 'failed'}`;
    if (target && target !== APP_RETURN) {
        return new Response(null, { status: 302, headers: { Location: `${target}/#${fragment}`, 'Cache-Control': 'no-store' } });
    }
    const title = ok ? `${label} connected` : 'Connection failed';
    const text = ok ? 'You can close this tab and return to Music Manager.' : 'Something went wrong. Return to Music Manager and try again.';
    const link = target ? `${target}#${fragment}` : null;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${link ? `\n<meta http-equiv="refresh" content="0;url=${escapeHtml(link)}">` : ''}
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#121212;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}a{color:#1db954}</style>
</head><body><main><h1>${title}</h1><p>${text}</p>${link ? `<p><a href="${escapeHtml(link)}">Open Music Manager</a></p>` : ''}</main></body></html>`;
    return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
