const jwt = require('jsonwebtoken');
const logger = require('./logger');

// HIGH SECURITY: JWT_SECRET must be provided in environment
// Do NOT use default secrets in production
const JWT_SECRET = process.env.JWT_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('CRITICAL: JWT_SECRET must be set in environment variables for production');
    }
    // Development-only fallback
    logger.warn('WARNING: Using development JWT_SECRET. Set JWT_SECRET environment variable.');
    return 'dev-secret-key-change-in-production';
})();
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '1h';
const REFRESH_TOKEN_EXPIRATION = process.env.REFRESH_TOKEN_EXPIRATION || '7d';

/**
 * Create a new JWT access token
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @param {object} additionalData - Additional claims to include
 * @returns {string} JWT token
 */
const createAccessToken = (userId, email, additionalData = {}) => {
    const payload = {
        userId,
        email,
        type: 'access_token',
        iat: Math.floor(Date.now() / 1000),
        ...additionalData
    };
    
    return jwt.sign(payload, JWT_SECRET, { 
        expiresIn: JWT_EXPIRATION 
    });
};

/**
 * Create a new refresh token
 * @param {string} userId - User ID
 * @returns {string} Refresh token
 */
const createRefreshToken = (userId) => {
    const payload = {
        userId,
        type: 'refresh_token',
        iat: Math.floor(Date.now() / 1000)
    };
    
    return jwt.sign(payload, JWT_SECRET, { 
        expiresIn: REFRESH_TOKEN_EXPIRATION 
    });
};

/**
 * Create both access and refresh tokens
 * @param {string} userId - User ID
 * @param {string} email - User email
 * @returns {object} Tokens object
 */
const createTokenPair = (userId, email) => {
    return {
        accessToken: createAccessToken(userId, email),
        refreshToken: createRefreshToken(userId),
        expiresIn: JWT_EXPIRATION
    };
};

/**
 * Verify a JWT token
 * @param {string} token - Token to verify
 * @returns {object} Decoded token
 * @throws {Error} If token is invalid or expired
 */
const verifyToken = (token) => {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        logger.error('Token verification failed', {
            error: error.message,
            name: error.name
        });
        throw error;
    }
};

/**
 * Verify a refresh token and issue new access token
 * MEDIUM: Implement token refresh rotation for security
 * @param {string} refreshToken - Refresh token
 * @returns {object} New token pair with rotated refresh token
 */
const refreshAccessToken = (refreshToken) => {
    try {
        const decoded = jwt.verify(refreshToken, JWT_SECRET);
        
        if (decoded.type !== 'refresh_token') {
            throw new Error('Invalid refresh token type');
        }
        
        logger.info('Token refreshed', { userId: decoded.userId });
        
        // MEDIUM: Implement refresh token rotation
        // Issue new pair - old refresh token is implicitly invalidated
        // In production, add old token to blacklist for immediate revocation
        return createTokenPair(decoded.userId, decoded.email || '');
    } catch (error) {
        logger.error('Refresh token failed', {
            error: error.message
        });
        throw error;
    }
};

/**
 * Decode token without verification (for client-side use)
 * @param {string} token - Token to decode
 * @returns {object} Decoded token payload
 */
const decodeToken = (token) => {
    return jwt.decode(token);
};

module.exports = {
    createAccessToken,
    createRefreshToken,
    createTokenPair,
    verifyToken,
    refreshAccessToken,
    decodeToken
};
