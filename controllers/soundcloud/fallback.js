// Provider selection for public SoundCloud reads, shared by the SoundCloud
// controller (legacy routes) and providers/soundcloud.js (library layer).
//
// Two ways to reach public SoundCloud content:
//   api    the official API (needs SOUNDCLOUD_CLIENT_ID / SECRET, Artist Pro)
//   ytdlp  yt-dlp, no credentials (see ./ytdlp.js for the caveats)
// SOUNDCLOUD_PROVIDER=auto (default) uses the API when configured and falls
// back to yt-dlp when it is not, or when an API call fails in a way yt-dlp
// might survive (rate limit, outage, network). `api` and `ytdlp` force one.
// The library (/me/*) is API-only either way: yt-dlp has no user session.
const client = require('./client');

function providerMode() {
    const mode = String(process.env.SOUNDCLOUD_PROVIDER || 'auto').toLowerCase();
    return ['api', 'ytdlp', 'auto'].includes(mode) ? mode : 'auto';
}

function activeProvider() {
    const mode = providerMode();
    if (mode === 'ytdlp') return 'ytdlp';
    if (mode === 'api') return 'api';
    return client.isConfigured() ? 'api' : 'ytdlp';
}

// Errors where trying yt-dlp instead is worthwhile. Auth failures on the user's
// own account are not: they need the user to reconnect, not another backend.
function shouldFallBack(err) {
    if (providerMode() !== 'auto') return false;
    if (!(err instanceof client.SoundCloudError)) return true; // network / unexpected
    return err.code === 'SOUNDCLOUD_NOT_CONFIGURED' || err.status === 429 || err.status >= 500;
}

// Runs `viaApi`, and on a recoverable failure runs `viaYtdlp` instead.
async function withFallback(label, viaApi, viaYtdlp) {
    const provider = activeProvider();
    if (provider === 'ytdlp') return viaYtdlp();
    try {
        return await viaApi();
    } catch (err) {
        if (!shouldFallBack(err)) throw err;
        console.warn(`SoundCloud ${label}: official API failed (${err.message}); falling back to yt-dlp.`);
        return viaYtdlp();
    }
}

module.exports = { providerMode, activeProvider, shouldFallBack, withFallback };
