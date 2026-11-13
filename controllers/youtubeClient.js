const { auth, youtube } = require('@googleapis/youtube');
const usage = require('../services/usage');

// The Data API calls the app makes. Each is counted with its quota cost
// (services/usage.js) at the moment it is sent, because Google charges a
// request whether or not it succeeds.
const METERED = Object.keys(usage.YOUTUBE_API_UNITS).map((name) => name.split('.'));

function meter(client) {
    for (const [resource, method] of METERED) {
        const target = client[resource];
        if (!target || typeof target[method] !== 'function') continue;
        const original = target[method].bind(target);
        target[method] = (...args) => {
            usage.recordYouTubeApi(`${resource}.${method}`);
            return original(...args);
        };
    }
    return client;
}

// Builds a YouTube Data API client authenticated with a user's Google OAuth
// access token. Shared by searchController and playlistController so the setup
// lives in one place.
function getYouTubeClient(token) {
    if (!token) throw new Error('No token provided');
    const oauth2Client = new auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });
    return meter(youtube({ version: 'v3', auth: oauth2Client }));
}

module.exports = { getYouTubeClient, meter };
