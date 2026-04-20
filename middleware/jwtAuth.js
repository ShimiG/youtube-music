const jwt = require('jsonwebtoken');
const tokenBlacklist = require('../services/tokenBlacklist');
const logger = require('../services/logger');

/**
 * JWT Authentication Middleware
 * Verifies JWT tokens from HTTP-only cookies or Authorization header
 * Sets req.userId and req.userEmail if valid
 * Checks token blacklist for revoked tokens (MEDIUM: Add token revocation)
 */
module.exports = (req, res, next) => {
    // Try to get token from HTTP-only cookie first, then Authorization header
    let token = req.cookies?.access_token || req.header('Authorization')?.replace('Bearer ', '').trim();
    
    if (!token || token === 'null' || token === 'undefined') {
        return res.status(401).json({ 
            error: "Access Denied. No token provided." 
        });
    }

    try {
        // MEDIUM: Check if token is blacklisted/revoked
        if (tokenBlacklist.isTokenBlacklisted(token)) {
            return res.status(401).json({ 
                error: "Token has been revoked. Please login again.",
                code: 'TOKEN_REVOKED'
            });
        }
        
        // Verify JWT signature and expiration
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-key');
        
        // Extract user info from verified token
        req.userId = decoded.userId;
        req.userEmail = decoded.email;
        req.token = decoded;
        req.accessToken = token; // Store token for potential refresh
        
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                error: "Token expired. Please login again.",
                code: 'TOKEN_EXPIRED'
            });
        }
        
        if (error.name === 'JsonWebTokenError') {
            logger.warn('Invalid JWT token attempted', { error: error.message });
            return res.status(401).json({ 
                error: "Invalid token." 
            });
        }
        
        logger.error('Authentication error', { error: error.message });
        return res.status(401).json({ 
            error: "Authentication failed." 
        });
    }
};
