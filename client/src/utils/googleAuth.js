import { startOAuth } from './desktop';

// Starts the Google connect flow for the logged-in user. The API returns a
// consent URL tied to our session through the signed `state`. In the browser
// the window goes there; in the desktop app it opens in the system browser.
// Either way the API callback stores the tokens server-side and reports the
// result as #google=connected&... (back to the web client, or into the app
// through a musicmanager:// link).
export async function connectGoogle() {
    try {
        const result = await startOAuth('http://localhost:3000/auth/google/url');
        if (!result.ok && result.status !== undefined) throw new Error(result.error || 'Failed to get Google auth URL');
    } catch (err) {
        console.error('Could not start Google connect flow:', err);
    }
}
