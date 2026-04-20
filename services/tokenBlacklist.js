/**
 * Token Blacklist/Revocation Service
 * Tracks revoked tokens to prevent their use
 * In production, use Redis for distributed cache
 */

const logger = require('./logger');

// In-memory storage (replace with Redis in production)
const blacklistedTokens = new Set();

// Cleanup interval: Remove expired tokens (1 hour)
const CLEANUP_INTERVAL = 60 * 60 * 1000;

setInterval(() => {
    if (blacklistedTokens.size > 0) {
        logger.info('Token blacklist cleanup', { size: blacklistedTokens.size });
        // Note: In production with Redis, expired entries are handled by Redis TTL
        blacklistedTokens.clear();
    }
}, CLEANUP_INTERVAL);

/**
 * Add a token to the blacklist
 * @param {string} token - Token to revoke
 * @param {number} expiresIn - Seconds until token expires
 */
const revokeToken = (token, expiresIn = 3600) => {
    if (!token) return;
    
    blacklistedTokens.add(token);
    
    // Auto-remove after expiration
    setTimeout(() => {
        blacklistedTokens.delete(token);
    }, expiresIn * 1000);
    
    logger.info('Token revoked', { expiresIn });
};

/**
 * Check if a token is blacklisted/revoked
 * @param {string} token - Token to check
 * @returns {boolean} True if blacklisted
 */
const isTokenBlacklisted = (token) => {
    return blacklistedTokens.has(token);
};

/**
 * Clear all blacklisted tokens (for testing)
 */
const clearBlacklist = () => {
    blacklistedTokens.clear();
    logger.info('Token blacklist cleared');
};

/**
 * Get blacklist size
 */
const getBlacklistSize = () => {
    return blacklistedTokens.size;
};

module.exports = {
    revokeToken,
    isTokenBlacklisted,
    clearBlacklist,
    getBlacklistSize
};
