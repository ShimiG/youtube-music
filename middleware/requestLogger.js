const logger = require('../services/logger');

/**
 * Request Logging Middleware
 * Logs all requests for audit trail and debugging
 */
module.exports = (req, res, next) => {
    // Log request details
    const startTime = Date.now();
    
    // Capture original send function
    const originalSend = res.send;
    
    res.send = function(data) {
        const duration = Date.now() - startTime;
        
        // Log the request
        logger.info('API Request', {
            method: req.method,
            path: req.path,
            query: req.query,
            ip: req.ip,
            userId: req.userId || 'anonymous',
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            timestamp: new Date().toISOString()
        });
        
        // Log errors
        if (res.statusCode >= 400) {
            logger.warn('Request Error', {
                method: req.method,
                path: req.path,
                statusCode: res.statusCode,
                error: data
            });
        }
        
        // Call original send
        res.send = originalSend;
        return res.send(data);
    };
    
    next();
};
