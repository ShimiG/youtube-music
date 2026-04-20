const { google } = require('googleapis');
const crypto = require('crypto');
const tokenService = require('../services/tokenService');
const logger = require('../services/logger');
require('dotenv').config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

/**
 * Initiate Google OAuth login
 * Generates CSRF state token to prevent CSRF attacks
 */
const googleLogin = async (req, res) => {
    try {
        // Generate CSRF state parameter
        const state = crypto.randomBytes(32).toString('hex');
        req.session.oauthState = state;
        
        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: [
                'https://www.googleapis.com/auth/youtube.readonly',
                'https://www.googleapis.com/auth/userinfo.profile',
                'https://www.googleapis.com/auth/userinfo.email'
            ],
            state: state  // CSRF protection
        });
        
        res.redirect(url);
    } catch (error) {
        logger.error('Google login failed', { error: error.message });
        res.status(500).json({ error: 'Authentication failed' });
    }
};

/**
 * Google OAuth callback handler
 * Exchanges authorization code for tokens
 * Issues JWT and sets secure HTTP-only cookies
 */
const googleCallback = async (req, res) => {
    const { code, state, error } = req.query;
    
    try {
        // Verify CSRF state parameter
        if (!state || state !== req.session.oauthState) {
            logger.warn('CSRF attack detected', { 
                ip: req.ip,
                sessionState: !!req.session.oauthState,
                receivedState: !!state
            });
            return res.status(400).json({ error: 'Invalid state parameter. CSRF attack suspected.' });
        }
        
        // Check for OAuth errors
        if (error) {
            logger.warn('Google OAuth error', { error });
            return res.status(400).json({ error: 'Authentication cancelled' });
        }
        
        if (!code) {
            return res.status(400).json({ error: 'No authorization code provided' });
        }
        
        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        
        if (!tokens || !tokens.access_token) {
            logger.error('No access token from Google');
            return res.status(400).json({ error: 'Authentication failed: No access token' });
        }
        
        // Get user info from Google
        const oauth2 = google.oauth2('v2');
        const userInfo = await oauth2.userinfo.get({
            auth: oauth2Client
        });
        
        const { email, name } = userInfo.data;
        
        // Create or get user in database
        const db = req.app.locals.db;
        let user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
        
        if (!user) {
            // Create new user for OAuth login
            const result = await db.run(
                'INSERT INTO users (username, email, auth_provider) VALUES (?, ?, ?)',
                [name || email, email, 'google']
            );
            user = { id: result.lastID, email };
        }
        
        // Create JWT token pair
        const tokenPair = tokenService.createTokenPair(user.id, email);
        
        // Store OAuth tokens in database for later use
        await db.run(
            `INSERT INTO user_connections (user_id, source_id, access_token, refresh_token) 
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, source_id) DO UPDATE SET 
                access_token = excluded.access_token,
                refresh_token = excluded.refresh_token`,
            [user.id, 'youtube', tokens.access_token, tokens.refresh_token || '']
        );
        
        // Set secure HTTP-only cookie with JWT
        res.cookie('access_token', tokenPair.accessToken, {
            httpOnly: true,              // Not accessible via JavaScript
            secure: process.env.NODE_ENV === 'production',  // HTTPS only in production
            sameSite: 'Strict',          // CSRF protection
            maxAge: 3600000,             // 1 hour
            path: '/'
        });
        
        // Set refresh token cookie (longer expiration)
        res.cookie('refresh_token', tokenPair.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
            path: '/'
        });
        
        // Store user info in session
        req.session.userId = user.id;
        req.session.email = email;
        
        logger.info('User authenticated via Google', { 
            userId: user.id, 
            email: email 
        });
        
        // Redirect to dashboard WITHOUT exposing token
        res.redirect('/auth/success?source=google');
    } catch (error) {
        logger.error('Google callback error', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Authentication failed' });
    }
};

/**
 * Authentication success endpoint
 * Returns user info after successful login
 */
const authSuccess = async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    res.json({
        authenticated: true,
        userId: req.session.userId,
        email: req.session.email,
        message: 'Authentication successful'
    });
};

/**
 * Logout endpoint
 * Clears session and cookies
 */
const logout = async (req, res) => {
    logger.info('User logout', { userId: req.session.userId });
    
    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
    req.session.destroy((err) => {
        if (err) {
            logger.error('Session destruction error', { error: err.message });
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.json({ message: 'Logged out successfully' });
    });
};

module.exports = { 
    googleLogin, 
    googleCallback,
    authSuccess,
    logout
};