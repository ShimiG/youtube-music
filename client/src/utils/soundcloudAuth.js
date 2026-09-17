// Starts the SoundCloud connect flow for the logged-in user. The API builds an
// OAuth 2.1 authorize URL (PKCE challenge + state tied to our session) and we
// send the whole window there. SoundCloud redirects back to the API callback,
// which exchanges the code server-side, stores the tokens, and bounces the
// browser back to the app with #soundcloud=connected&expires_at=... in the URL
// fragment. Tokens never reach the client; the server refreshes them itself.
export async function connectSoundCloud() {
    const authToken = localStorage.getItem('authToken');
    if (!authToken) return;

    try {
        const res = await fetch('http://localhost:3000/auth/soundcloud/url', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 503) {
            alert(data.error || 'SoundCloud is not configured on this server.');
            return;
        }
        if (!res.ok) throw new Error(data.error || 'Failed to get SoundCloud auth URL');
        window.location.href = data.url;
    } catch (err) {
        console.error('Could not start SoundCloud connect flow:', err);
    }
}
