// Starts the Google connect flow for the logged-in user: asks the API for a
// consent URL (tied to our session via the state param), then sends the whole
// window to Google. Google redirects back to the API callback, which stores
// the tokens server-side and bounces the browser back to the app with
// #google=connected&expires_at=... in the URL fragment.
//
// connectGoogle({ scope: 'write' }) asks for the youtube write scope as well,
// which liking/unliking needs. The default consent stays read-only.
export async function connectGoogle({ scope } = {}) {
    const authToken = localStorage.getItem('authToken');
    if (!authToken) return;

    try {
        const query = scope === 'write' ? '?scope=write' : '';
        const res = await fetch(`http://localhost:3000/auth/google/url${query}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!res.ok) throw new Error('Failed to get Google auth URL');
        const { url } = await res.json();
        window.location.href = url;
    } catch (err) {
        console.error('Could not start Google connect flow:', err);
    }
}
