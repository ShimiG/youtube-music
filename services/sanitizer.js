/**
 * Input Sanitization and Output Encoding Utilities
 * Prevents XSS attacks through user-supplied data
 */

const he = require('he');
const logger = require('./logger');

/**
 * Encode HTML entities to prevent XSS
 * @param {string} text - Text to encode
 * @returns {string} HTML-encoded text
 */
const encodeHTML = (text) => {
    if (!text || typeof text !== 'string') return '';
    return he.encode(text);
};

/**
 * Sanitize user-provided string input
 * @param {string} input - Input to sanitize
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} Sanitized input
 */
const sanitizeString = (input, maxLength = 500) => {
    if (!input || typeof input !== 'string') return '';
    
    // Remove any HTML/scripts and trim
    let sanitized = input.trim();
    
    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');
    
    // Limit length
    if (sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength);
    }
    
    return sanitized;
};

/**
 * Sanitize object recursively (for database queries)
 * @param {object} obj - Object to sanitize
 * @returns {object} Sanitized object
 */
const sanitizeObject = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    
    const sanitized = {};
    
    for (const [key, value] of Object.entries(obj)) {
        // Skip null/undefined
        if (value === null || value === undefined) {
            sanitized[key] = value;
            continue;
        }
        
        // Sanitize strings
        if (typeof value === 'string') {
            sanitized[key] = sanitizeString(value);
        } 
        // Recursively sanitize nested objects
        else if (typeof value === 'object' && !Array.isArray(value)) {
            sanitized[key] = sanitizeObject(value);
        }
        // Handle arrays
        else if (Array.isArray(value)) {
            sanitized[key] = value.map(item => 
                typeof item === 'string' ? sanitizeString(item) : item
            );
        }
        else {
            sanitized[key] = value;
        }
    }
    
    return sanitized;
};

/**
 * Encode API response to prevent XSS
 * @param {object} data - Response data
 * @returns {object} Encoded response
 */
const encodeResponse = (data) => {
    if (!data || typeof data !== 'object') return data;
    
    if (Array.isArray(data)) {
        return data.map(item => encodeResponse(item));
    }
    
    const encoded = {};
    
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
            encoded[key] = encodeHTML(value);
        } else if (typeof value === 'object' && value !== null) {
            encoded[key] = encodeResponse(value);
        } else {
            encoded[key] = value;
        }
    }
    
    return encoded;
};

/**
 * Validate and sanitize email
 * @param {string} email - Email to validate
 * @returns {string|null} Sanitized email or null if invalid
 */
const validateAndSanitizeEmail = (email) => {
    if (!email || typeof email !== 'string') return null;
    
    const sanitized = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(sanitized) || sanitized.length > 255) {
        return null;
    }
    
    return sanitized;
};

/**
 * Validate and sanitize username
 * @param {string} username - Username to validate
 * @returns {string|null} Sanitized username or null if invalid
 */
const validateAndSanitizeUsername = (username) => {
    if (!username || typeof username !== 'string') return null;
    
    const sanitized = username.trim();
    
    // Username: 3-50 chars, alphanumeric + underscore/hyphen
    if (!/^[a-zA-Z0-9_-]{3,50}$/.test(sanitized)) {
        return null;
    }
    
    // Check for reserved names
    const reservedNames = ['admin', 'root', 'system', 'moderator', 'bot', 'test'];
    if (reservedNames.includes(sanitized.toLowerCase())) {
        return null;
    }
    
    return sanitized;
};

/**
 * Validate video ID
 * @param {string} videoId - Video ID to validate
 * @returns {boolean} True if valid
 */
const validateVideoId = (videoId) => {
    if (!videoId || typeof videoId !== 'string') return false;
    // YouTube video IDs are 11 characters: A-Z, a-z, 0-9, -, _
    return /^[A-Za-z0-9_-]{11}$/.test(videoId);
};

/**
 * Validate playlist name
 * @param {string} name - Name to validate
 * @returns {string|null} Sanitized name or null if invalid
 */
const validatePlaylistName = (name) => {
    if (!name || typeof name !== 'string') return null;
    
    const sanitized = name.trim();
    
    if (sanitized.length < 1 || sanitized.length > 100) {
        return null;
    }
    
    // Remove potentially dangerous characters
    return encodeHTML(sanitized);
};

module.exports = {
    encodeHTML,
    sanitizeString,
    sanitizeObject,
    encodeResponse,
    validateAndSanitizeEmail,
    validateAndSanitizeUsername,
    validateVideoId,
    validatePlaylistName
};
