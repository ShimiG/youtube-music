const { google } = require('googleapis');

// Builds a YouTube Data API client authenticated with a user's Google OAuth
// access token. Shared by searchController and playlistController so the setup
// lives in one place.
function getYouTubeClient(token) {
    if (!token) throw new Error('No token provided');
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: token });
    return google.youtube({ version: 'v3', auth: oauth2Client });
}

module.exports = { getYouTubeClient };
