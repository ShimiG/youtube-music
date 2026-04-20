/**
 * Express Validator Configuration
 * Centralized validation chains for controllers
 */

const { body, query, param, validationResult } = require('express-validator');

/**
 * Validation middleware to handle validation errors
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            error: 'Validation failed',
            details: errors.array().map(e => ({
                field: e.param,
                message: e.msg
            }))
        });
    }
    next();
};

/**
 * User registration validation
 */
const validateRegistration = [
    body('username')
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be 3-50 characters')
        .matches(/^[a-zA-Z0-9_-]+$/)
        .withMessage('Username can only contain alphanumeric characters, underscores, and hyphens'),
    
    body('email')
        .trim()
        .isEmail()
        .withMessage('Invalid email format')
        .normalizeEmail(),
    
    body('password')
        .isLength({ min: 12 })
        .withMessage('Password must be at least 12 characters'),
    
    handleValidationErrors
];

/**
 * User login validation
 */
const validateLogin = [
    body('username')
        .trim()
        .notEmpty()
        .withMessage('Username required'),
    
    body('password')
        .notEmpty()
        .withMessage('Password required'),
    
    handleValidationErrors
];

/**
 * Token refresh validation
 */
const validateTokenRefresh = [
    body('refreshToken')
        .isString()
        .notEmpty()
        .withMessage('Valid refresh token required'),
    
    handleValidationErrors
];

/**
 * Search query validation
 */
const validateSearchQuery = [
    query('q')
        .trim()
        .isLength({ min: 1, max: 500 })
        .withMessage('Search query must be 1-500 characters'),
    
    handleValidationErrors
];

/**
 * Video ID validation
 */
const validateVideoId = [
    param('videoId')
        .matches(/^[A-Za-z0-9_-]{11}$/)
        .withMessage('Invalid video ID format'),
    
    handleValidationErrors
];

/**
 * Playlist creation validation
 */
const validateCreatePlaylist = [
    body('name')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('Playlist name must be 1-100 characters'),
    
    body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description must be 500 characters or less'),
    
    handleValidationErrors
];

/**
 * Add track to playlist validation
 */
const validateAddTrackToPlaylist = [
    param('playlistId')
        .isInt()
        .withMessage('Invalid playlist ID'),
    
    body('sourceName')
        .trim()
        .isIn(['youtube', 'spotify', 'soundcloud'])
        .withMessage('Invalid source name'),
    
    body('externalId')
        .trim()
        .notEmpty()
        .withMessage('External ID required'),
    
    body('title')
        .trim()
        .isLength({ min: 1, max: 255 })
        .withMessage('Title must be 1-255 characters'),
    
    body('artist')
        .optional()
        .trim()
        .isLength({ max: 255 })
        .withMessage('Artist must be 255 characters or less'),
    
    handleValidationErrors
];

/**
 * Playlist ID validation
 */
const validatePlaylistId = [
    param('playlistId')
        .isInt()
        .withMessage('Invalid playlist ID'),
    
    handleValidationErrors
];

module.exports = {
    handleValidationErrors,
    validateRegistration,
    validateLogin,
    validateTokenRefresh,
    validateSearchQuery,
    validateVideoId,
    validateCreatePlaylist,
    validateAddTrackToPlaylist,
    validatePlaylistId
};
