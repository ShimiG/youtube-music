
const express = require('express');
const router = express.Router();
const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI
);



router.get('/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/youtube.force-ssl',
        'https://www.googleapis.com/auth/userinfo.profile'
    ];

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', 
        prompt: 'consent',      
        scope: scopes
    });


    res.redirect(url); 
});

router.get('/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code received');

    try {
        const { tokens } = await oauth2Client.getToken(code);
        

        const params = new URLSearchParams({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || '' 
        });

       res.redirect(`http://localhost:5173?access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token}`);

    } catch (error) {
        console.error('Error retrieving token', error);
        res.status(500).send('Authentication failed');
    }
});

router.post('/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: "No refresh token" });

    try {
        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.REDIRECT_URI
        );

        client.setCredentials({ refresh_token: refresh_token });

        const { credentials } = await client.refreshAccessToken();

        res.json({ access_token: credentials.access_token });

    } catch (error) {
        console.error("Refresh Failed:", error.message);
        res.status(401).json({ error: "Could not refresh token" });
    }
});

router.get('/me', async (req, res) => {
    const authHeader = req.header('Authorization');
    const token = authHeader ? authHeader.replace('Bearer ', '') : null;

    if (!token) return res.status(401).json({ error: "No token" });

    try {
        oauth2Client.setCredentials({ access_token: token });
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        res.json({ name: userInfo.data.name, picture: userInfo.data.picture });
    } catch (error) {
        res.status(error.response?.status || 500).json({ error: "Profile fetch failed" });
    }
});

module.exports = router;