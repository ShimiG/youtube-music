const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    // 1. Get the token from the request header
    // The frontend will send it like: "header: { 'Authorization': 'eyJhbGci...' }"
    const token = req.header('Authorization');

    // 2. Check if token exists
    if (!token) {
        return res.status(401).json({ error: "Access Denied. No token provided." });
    }

    try {
        // 3. Verify the token using your secret key
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key_123');
        
        // 4. Attach the User ID to the request object
        // This is the magic step! Now every route knows exactly who "req.user" is.
        req.user = decoded; 
        
        next(); // Move to the next step (the actual route)
    } catch (error) {
        res.status(400).json({ error: "Invalid Token" });
    }
};