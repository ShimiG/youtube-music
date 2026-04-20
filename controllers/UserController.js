const crypto = require('crypto');
const bcrypt = require('bcrypt');
const tokenService = require('../services/tokenService');
const logger = require('../services/logger');
const tokenBlacklist = require('../services/tokenBlacklist');
const sanitizer = require('../services/sanitizer');
const { body, validationResult } = require('express-validator');

/**
 * Validate email format
 */
const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email) && email.length <= 255;
};

/**
 * Check if password is commonly used
 */
const isCommonPassword = (password) => {
    const commonPasswords = [
        'password', '123456', 'password123', 'admin', 'letmein',
        'welcome', 'monkey', 'dragon', 'master', 'sunshine'
    ];
    return commonPasswords.some(common => password.toLowerCase().includes(common));
};

/**
 * Validate password strength
 * Requires: 12+ characters, uppercase, lowercase, number, special character
 */
const validatePasswordStrength = (password) => {
    const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{12,}$/;
    return regex.test(password) && !isCommonPassword(password);
};

/**
 * Hash password with bcrypt
 */
const hashPassword = async (password) => {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
};

/**
 * Register a new local user
 */
const registerUser = async (req, res) => {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, password } = req.body;

    // Validate email format
    if (!validateEmail(email)) {
        return res.status(400).json({
            error: 'Invalid email format'
        });
    }

    // Validate password strength
    if (!validatePasswordStrength(password)) {
        return res.status(400).json({
            error: 'Password must be at least 12 characters with uppercase, lowercase, number, special character, and not contain common passwords'
        });
    }

    const db = req.app.locals.db;

    try {
        // Check if user already exists
        const existingUser = await db.get(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            [username, email]
        );

        if (existingUser) {
            return res.status(409).json({ error: 'Username or email already exists' });
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const result = await db.run(
            'INSERT INTO users (username, email, password, auth_provider) VALUES (?, ?, ?, ?)',
            [username, email, hashedPassword, 'local']
        );

        logger.info('User registered', { userId: result.lastID, email, username });

        // Create JWT token pair
        const tokenPair = tokenService.createTokenPair(result.lastID, email);

        // Set secure HTTP-only cookies
        res.cookie('access_token', tokenPair.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Strict',
            maxAge: 3600000,
            path: '/'
        });

        res.cookie('refresh_token', tokenPair.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/'
        });

        // Store in session
        req.session.userId = result.lastID;
        req.session.email = email;

        res.status(201).json({
            userId: result.lastID,
            username,
            email,
            message: 'Registration successful'
        });
    } catch (err) {
        logger.error('Registration error', { error: err.message });
        return res.status(500).json({ error: 'Registration failed' });
    }
};

/**
 * Login with username and password
 */
const loginUser = async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const db = req.app.locals.db;

    try {
        // Get user from database
        const user = await db.get(
            'SELECT id, email, username, password FROM users WHERE username = ? AND auth_provider = ?',
            [username, 'local']
        );

        if (!user) {
            logger.warn('Login failed - user not found', { username, ip: req.ip });
            // Don't reveal if user exists
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // Compare password
        const passwordMatches = await bcrypt.compare(password, user.password);
        if (!passwordMatches) {
            logger.warn('Login failed - invalid password', { userId: user.id, ip: req.ip });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        // SECURITY: Regenerate session to prevent session fixation attacks
        req.session.regenerate((err) => {
            if (err) {
                logger.error('Session regeneration failed', { error: err.message });
                return res.status(500).json({ error: 'Login failed' });
            }

            // Create JWT token pair
            const tokenPair = tokenService.createTokenPair(user.id, user.email);

            // Set secure HTTP-only cookies
            res.cookie('access_token', tokenPair.accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'Strict',
                maxAge: 3600000,
                path: '/'
            });

            res.cookie('refresh_token', tokenPair.refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'Strict',
                maxAge: 7 * 24 * 60 * 60 * 1000,
                path: '/'
            });

            // Store in new session
            req.session.userId = user.id;
            req.session.email = user.email;

        logger.info('User logged in', { userId: user.id, username });

            res.status(200).json({
                userId: user.id,
                username: user.username,
                email: user.email,
                message: 'Login successful'
            });
        });
    } catch (err) {
        logger.error('Login error', { error: err.message });
        return res.status(500).json({ error: 'Login failed' });
    }
};

/**
 * Refresh access token using refresh token
 * PHASE 2: Enhanced with better validation and security
 */
const refreshAccessTokenEndpoint = async (req, res) => {
    const { refreshToken: providedRefreshToken } = req.body;

    if (!providedRefreshToken || typeof providedRefreshToken !== 'string') {
        return res.status(400).json({ error: 'Valid refresh token required' });
    }

    try {
        // Verify refresh token not already revoked
        if (tokenBlacklist.isTokenBlacklisted(providedRefreshToken)) {
            logger.warn('Token refresh attempt with revoked token', { ip: req.ip });
            return res.status(401).json({ 
                error: 'Session expired. Please login again.',
                code: 'SESSION_EXPIRED'
            });
        }

        // Get new token pair
        const tokenPair = tokenService.refreshAccessToken(providedRefreshToken);

        // Set new tokens in secure cookies
        res.cookie('access_token', tokenPair.accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Strict',
            maxAge: 3600000,
            path: '/'
        });

        res.cookie('refresh_token', tokenPair.refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Strict',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/'
        });

        logger.info('Token refreshed successfully');

        res.json({
            success: true,
            accessToken: tokenPair.accessToken,
            expiresIn: tokenPair.expiresIn,
            message: 'Token refreshed'
        });
    } catch (err) {
        if (err.name === 'TokenExpiredError' || err.message.includes('expired')) {
            logger.warn('Refresh token expired', { error: err.message });
            return res.status(401).json({ 
                error: 'Refresh token expired. Please login again.',
                code: 'REFRESH_EXPIRED'
            });
        }
        
        logger.error('Token refresh failed', { error: err.message });
        return res.status(401).json({ error: 'Token refresh failed' });
    }
};

/**
 * Logout user and revoke all tokens
 * PHASE 2: Implement logout revocation
 */
const logoutUser = async (req, res) => {
    try {
        const accessToken = req.cookies?.access_token || req.accessToken;
        const refreshToken = req.cookies?.refresh_token;
        const userId = req.userId;

        // Revoke both tokens
        if (accessToken) {
            tokenBlacklist.revokeToken(accessToken, 3600); // 1 hour expiration
        }
        if (refreshToken) {
            tokenBlacklist.revokeToken(refreshToken, 7 * 24 * 60 * 60); // 7 days
        }

        // Clear cookies
        res.clearCookie('access_token', { path: '/' });
        res.clearCookie('refresh_token', { path: '/' });

        // Destroy session
        req.session.destroy((err) => {
            if (err) {
                logger.error('Session destruction failed', { error: err.message });
            }
        });

        logger.info('User logged out', { userId, ip: req.ip });

        res.json({ 
            success: true,
            message: 'Logged out successfully' 
        });
    } catch (err) {
        logger.error('Logout error', { error: err.message });
        res.status(500).json({ error: 'Logout failed' });
    }
};

/**
 * Get current user info
 * PHASE 2: Sanitize response to prevent XSS
 */
const getCurrentUser = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = req.userId;

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = await db.get(
            'SELECT id, username, email, auth_provider, created_at FROM users WHERE id = ?',
            [userId]
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // PHASE 2: Sanitize response output
        const sanitizedUser = sanitizer.encodeResponse({
            id: user.id,
            username: user.username,
            email: user.email,
            authProvider: user.auth_provider,
            createdAt: user.created_at
        });

        res.json(sanitizedUser);
    } catch (err) {
        logger.error('Get user failed', { error: err.message });
        res.status(500).json({ error: 'Failed to retrieve user info' });
    }
};

/**
 * Refresh access token using refresh token (legacy)
 */
const refreshToken = async (req, res) => {
    return refreshAccessTokenEndpoint(req, res);
};

module.exports = {
    registerUser,
    loginUser,
    refreshToken,
    refreshAccessTokenEndpoint,
    logoutUser,
    getCurrentUser,
    validatePasswordStrength
};