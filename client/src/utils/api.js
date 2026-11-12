// The one way the client talks to the API: attaches our session JWT, parses
// JSON, and turns a non-2xx response into an ApiError carrying the server's
// `code` and `source` so callers can react to SOURCE_NOT_CONNECTED etc.
export const API_BASE = 'http://localhost:3000';

export class ApiError extends Error {
    constructor(message, { status, code, source, body } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code || null;
        this.source = source || null;
        this.body = body || {};
    }
}

export function authHeaders() {
    const token = localStorage.getItem('authToken');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new ApiError(data.error || `Request failed (${res.status})`, {
            status: res.status, code: data.code, source: data.source, body: data
        });
    }
    return data;
}

/**
 * Resolves true as soon as the local server answers anything at all, false
 * if it has not within `timeoutMs` (or the wait was aborted). Used once, at
 * start-up (components/ServerGate.jsx).
 */
export async function waitForServer(signal, { timeoutMs = 20000, everyMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fetch(`${API_BASE}/api/cloud/info`, { signal, cache: 'no-store' });
            return true;
        } catch {
            if (signal && signal.aborted) return false;
        }
        if (Date.now() + everyMs > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        if (signal && signal.aborted) return false;
    }
}
