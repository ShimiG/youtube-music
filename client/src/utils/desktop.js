// Desktop (Tauri v2) integration. Everything here is a no-op in a normal
// browser, so the web build keeps working unchanged; the Tauri plugins are
// loaded lazily only inside the app.

export const isDesktopApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Opens an https URL in the system browser (desktop) or a new tab (web). */
export async function openExternal(url) {
    if (isDesktopApp()) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        return openUrl(url);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Starts an OAuth connect flow. In the browser the window itself goes to the
 * consent page (and comes back via CLIENT_ORIGIN). In the desktop app the
 * consent page opens in the system browser, where the user is already signed
 * in to Google / SoundCloud, and the server hands the result back through a
 * musicmanager://oauth deep link (see onOAuthResult).
 */
export async function startOAuth(urlEndpoint, params = {}) {
    const authToken = localStorage.getItem('authToken');
    if (!authToken) return { ok: false };
    const query = new URLSearchParams(params);
    if (isDesktopApp()) query.set('return', 'app');
    const endpoint = query.toString() ? `${urlEndpoint}?${query}` : urlEndpoint;
    const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${authToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) return { ok: false, status: res.status, error: data.error };
    if (isDesktopApp()) await openExternal(data.url);
    else window.location.href = data.url;
    return { ok: true };
}

/**
 * Calls handler(fragment) for every musicmanager://oauth#... link the app
 * receives (including one that launched it). Returns an unsubscribe function.
 */
export async function onOAuthResult(handler) {
    if (!isDesktopApp()) return () => {};
    const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
    const deliver = (urls) => {
        for (const raw of urls || []) {
            try {
                const url = new URL(raw);
                if (url.protocol === 'musicmanager:' && url.host === 'oauth') handler(url.hash.slice(1));
            } catch { /* not a URL we handle */ }
        }
    };
    deliver(await getCurrent());
    return onOpenUrl(deliver);
}
