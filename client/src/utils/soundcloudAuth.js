import { startOAuth } from './desktop';

// Starts the SoundCloud connect flow (OAuth 2.1 + PKCE; the verifier stays on
// the server). Same shape as connectGoogle: browser window or system browser,
// result reported as #soundcloud=connected&... Tokens never reach the client;
// the server refreshes them itself.
export async function connectSoundCloud() {
    try {
        const result = await startOAuth('http://localhost:3000/auth/soundcloud/url');
        if (result.status === 503) {
            alert(result.error || 'SoundCloud is not configured on this server.');
            return;
        }
        if (!result.ok && result.status !== undefined) throw new Error(result.error || 'Failed to get SoundCloud auth URL');
    } catch (err) {
        console.error('Could not start SoundCloud connect flow:', err);
    }
}
