const express = require('express');
const router = express.Router();
const { google } = require('googleapis');

// Setup Google Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
);

// 1. LOGIN ROUTE
router.get('/login', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/youtube.force-ssl',
        'https://www.googleapis.com/auth/userinfo.profile'
    ];

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', // ESSENTIAL: Asks for a Refresh Token
        prompt: 'consent',      // ESSENTIAL: Forces Google to give it every time
        scope: scopes
    });

    res.redirect(url);
});

// 2. CALLBACK ROUTE
router.get('/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code received');

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        // We pass BOTH tokens to the frontend
        // access_token = Short lived (1 hour)
        // refresh_token = Long lived (Forever-ish)
        const params = new URLSearchParams({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || '' 
        });

        res.redirect(`/?${params.toString()}`);

    } catch (error) {
        console.error('Error retrieving token', error);
        res.status(500).send('Authentication failed');
    }
});

// 3. NEW: REFRESH TOKEN ROUTE
router.post('/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: "No refresh token" });

    try {
        // Create a new client just for this request
        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.REDIRECT_URI
        );

        // Manually set the refresh token
        client.setCredentials({ refresh_token: refresh_token });

        // Ask Google for a new Access Token
        const { credentials } = await client.refreshAccessToken();

        // Return the new short-lived token
        res.json({ access_token: credentials.access_token });

    } catch (error) {
        console.error("Refresh Failed:", error.message);
        res.status(401).json({ error: "Could not refresh token" });
    }
});

// 4. GET PROFILE ROUTE (From previous step)
router.get('/me', async (req, res) => {
    const token = req.header('Authorization');
    if (!token) return res.status(401).json({ error: "No token" });

    try {
        oauth2Client.setCredentials({ access_token: token });
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        res.json({ name: userInfo.data.name, picture: userInfo.data.picture });
    } catch (error) {
        // If this fails with 401, the Frontend will now know to call /refresh
        res.status(error.response?.status || 500).json({ error: "Profile fetch failed" });
    }
});

module.exports = router;