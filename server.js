const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
require('dotenv').config();

// --- IMPORT CONFIG & MIDDLEWARE ---
const initDB = require('./config/db');
const jwtAuth = require('./middleware/jwtAuth');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const validators = require('./middleware/validators');
const logger = require('./services/logger');

// --- IMPORT CONTROLLERS ---
const authController = require('./controllers/authController');
const searchController = require('./controllers/searchController');
const playlistController = require('./controllers/playlistController');
const historyController = require('./controllers/historyController');
const streamingController = require('./controllers/streamingController');
const YouTubeController = require('./controllers/YouTubeController');
const { registerUser, loginUser, refreshToken, logoutUser, getCurrentUser } = require('./controllers/UserController');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ==========================================
// SECURITY MIDDLEWARE
// ==========================================

// Helmet: Security headers (CF-6: Enable CSP)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://www.googleapis.com", "https://www.youtube.com"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: []
        }
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// CORS: Restrict to allowed origins (CF-3: Restrict CORS)
const corsAllowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',');
const corsOptions = {
    origin: corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Total-Count'],
    maxAge: 86400
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Management
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: NODE_ENV === 'production',  // HTTPS only in production
        sameSite: 'Strict',
        maxAge: 3600000  // 1 hour
    }
}));

// Request Logging Middleware
app.use(requestLogger);

// ==========================================
// ADDITIONAL SECURITY HEADERS
// ==========================================

// Apply additional security headers
app.use((req, res, next) => {
    // X-Content-Type-Options: Prevent MIME-sniffing (MEDIUM: Fix missing header)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Cache-Control: Prevent sensitive data caching (MEDIUM: Add Cache-Control)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Additional security headers
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    next();
});

// ==========================================
// RATE LIMITING (CF-7: Add rate limiting)
// ==========================================

// Brute force protection on auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 5,                     // 5 attempts per IP
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many authentication attempts. Please try again later.'
});

// Registration rate limiter (stricter)
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,   // 1 hour
    max: 3,                      // 3 registrations per IP per hour
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many registration attempts. Please try again later.'
});

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,    // 1 minute
    max: 100,                   // 100 requests per IP
    standardHeaders: true,
    legacyHeaders: false
});

// Duration endpoint rate limiter (expensive operation)
const durationLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,    // 1 minute
    max: 30,                    // 30 requests per IP per minute
    standardHeaders: true,
    legacyHeaders: false
});

// History endpoint rate limiter (MEDIUM: Add rate limiting)
const historyLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,    // 1 minute
    max: 50,                     // 50 requests per minute
    standardHeaders: true,
    legacyHeaders: false
});

// ==========================================
// ROUTES
// ==========================================

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// AUTHENTICATION ROUTES (No JWT required)
// ==========================================

// Google OAuth
app.get('/auth/google', authLimiter, authController.googleLogin);
app.get('/auth/google/callback', authController.googleCallback);

// Local authentication
app.post('/api/register', 
    registerLimiter,
    validators.validateRegistration,
    registerUser
);

app.post('/api/login',
    authLimiter,
    validators.validateLogin,
    loginUser
);

// Token refresh - PHASE 2: Enhanced with validation
app.post('/api/refresh-token', 
    authLimiter,
    validators.validateTokenRefresh,
    refreshToken
);

// Logout - PHASE 2: With token revocation
app.post('/auth/logout', jwtAuth, logoutUser);

// Get current user info - PHASE 2: New endpoint with XSS protection
app.get('/auth/me', jwtAuth, getCurrentUser);

// Auth success check
app.get('/auth/success', authController.authSuccess);

// ==========================================
// PROTECTED API ROUTES (JWT required)
// ==========================================

// Apply JWT authentication to all protected routes
app.use('/api/', jwtAuth);
app.use('/search', jwtAuth);
app.use('/playlists', jwtAuth);
app.use('/stream', jwtAuth);  // CF-2: Protect streaming endpoint
app.use('/history', jwtAuth);

// Search Route
app.get('/search', apiLimiter, searchController.searchTracks);

// YouTube Playlist Routes
app.get('/playlists', apiLimiter, playlistController.getUserPlaylists);
app.get('/playlists/:id/tracks', apiLimiter, playlistController.getPlaylistTracks);

// Streaming Route (CF-2: Now protected with JWT)
app.get('/stream', apiLimiter, streamingController.handleStream);

// YouTube Duration Route (now protected)
app.get('/duration', durationLimiter, YouTubeController.getDuration);

// Custom Playlist Routes (Local DB) - PHASE 2: With validation
app.get('/api/custom-playlists', apiLimiter, playlistController.getCustomPlaylists);
app.post('/api/custom-playlists', apiLimiter, validators.validateCreatePlaylist, playlistController.createCustomPlaylist);
app.get('/api/custom-playlists/:playlistId/tracks', apiLimiter, validators.validatePlaylistId, playlistController.getCustomPlaylistTracks);
app.post('/api/custom-playlists/:playlistId/tracks', apiLimiter, validators.validateAddTrackToPlaylist, playlistController.addTrackToPlaylist);

// History Routes (with rate limiting - MEDIUM: Add rate limiting)
app.post('/history', historyLimiter, historyController.logHistory);
app.get('/history', historyLimiter, historyController.getHistory);

// ==========================================
// ERROR HANDLING
// ==========================================

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Centralized error handler (must be last)
app.use(errorHandler);

// ==========================================
// SERVER INITIALIZATION WITH HTTPS SUPPORT
// ==========================================

initDB().then(db => {
    app.locals.db = db;
    
    let server;
    
    // HTTPS configuration for production (HIGH: Add HTTPS enforcement)
    if (NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true') {
        const keyPath = process.env.SSL_KEY_PATH;
        const certPath = process.env.SSL_CERT_PATH;
        
        if (!keyPath || !certPath) {
            logger.error('HTTPS enabled but SSL paths not configured');
            process.exit(1);
        }
        
        try {
            const key = fs.readFileSync(keyPath, 'utf8');
            const cert = fs.readFileSync(certPath, 'utf8');
            server = https.createServer({ key, cert }, app);
            logger.info('HTTPS server created', { keyPath, certPath });
        } catch (err) {
            logger.error('Failed to load SSL certificates', { error: err.message });
            process.exit(1);
        }
    } else {
        const http = require('http');
        server = http.createServer(app);
        if (NODE_ENV === 'production') {
            logger.warn('WARNING: HTTPS not enabled in production. Set HTTPS_ENABLED=true and configure SSL paths.');\n        }
    }
    
    server.listen(PORT, () => {
        logger.info('Server started', {
            port: PORT,
            environment: NODE_ENV,
            protocol: NODE_ENV === 'production' && process.env.HTTPS_ENABLED === 'true' ? 'HTTPS' : 'HTTP'
        });
    });
    
    // Graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM signal received: closing HTTP server');
        server.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
        });
    });
    
}).catch(err => {
    logger.error('Failed to initialize database', { error: err.message });
    process.exit(1);
});