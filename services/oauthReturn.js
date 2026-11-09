// Where the browser goes after an OAuth connect flow finishes.
//
// Two fixed targets, chosen when the flow starts (`?return=app` on the
// /auth/<service>/url request) and carried through the signed state, never
// taken from the callback request itself, so this can't be an open redirect:
//   web: CLIENT_ORIGIN (the Vite dev server or a browser tab), as before.
//   app: the desktop app's musicmanager:// deep link. The consent page opens
//        in the system browser, so the result has to be handed back to the
//        app; the OS routes musicmanager:// to it (tauri-plugin-deep-link).
//
// Results travel in the URL fragment (#google=connected&...), which never
// reaches a server or its logs. Fragments are built from fixed strings and
// numbers only.
const APP_RETURN_URL = 'musicmanager://oauth';

const clientOrigin = () => (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim();

/** Normalises the `return` query value; anything but "app" means web. */
const parseReturnTarget = (value) => (value === 'app' ? 'app' : 'web');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Finishes the flow. Web: a plain redirect back to the client. App: a small
 * page that hands the result to the app through the deep link (a meta
 * refresh, since helmet's CSP forbids inline scripts) and tells the user they
 * can close the tab; browsers ask before opening an app, and a page is
 * clearer than a blank tab if they decline.
 */
function finishOAuth(res, target, fragment) {
    if (target !== 'app') return res.redirect(`${clientOrigin()}/#${fragment}`);

    const link = `${APP_RETURN_URL}#${fragment}`;
    const ok = /=connected(&|$)/.test(fragment);
    const title = ok ? 'Account connected' : 'Connection failed';
    const body = ok
        ? 'You can close this tab and return to Music Manager.'
        : 'Something went wrong. Return to Music Manager and try again.';
    res.set('Cache-Control', 'no-store');
    return res.status(200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${escapeHtml(link)}">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#121212;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:24px}a{color:#1db954}</style>
</head><body><main><h1>${title}</h1><p>${body}</p><p><a href="${escapeHtml(link)}">Open Music Manager</a></p></main></body></html>`);
}

module.exports = { APP_RETURN_URL, parseReturnTarget, finishOAuth, clientOrigin };
