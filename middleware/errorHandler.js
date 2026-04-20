/**
 * Centralized Error Handler Middleware
 * Catches and logs all errors
 */
module.exports = (err, req, res, next) => {
    console.error('Error:', err);
    
    // Prevent information disclosure in production
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    // Handle known error types
    if (err.name === 'ValidationError') {
        return res.status(400).json({ 
            error: "Validation failed",
            details: isDevelopment ? err.message : undefined
        });
    }
    
    if (err.name === 'UnauthorizedError') {
        return res.status(401).json({ 
            error: "Unauthorized" 
        });
    }
    
    if (err.name === 'ForbiddenError') {
        return res.status(403).json({ 
            error: "Forbidden" 
        });
    }
    
    // Default error response
    res.status(err.statusCode || 500).json({
        error: isDevelopment ? err.message : "An error occurred",
        ...(isDevelopment && { stack: err.stack })
    });
};
