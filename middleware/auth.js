module.exports = (req, res, next) => {
    // Get the token from the request header
    const authHeader = req.header('Authorization');

    // Check if token exists
    if (!authHeader) {
        return res.status(401).json({ error: "Access Denied. No token provided." });
    }

    const token = authHeader.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ error: "Invalid token format" });
    }

    // Attach the OAuth token to the request object
    // Routes will use this token to make authenticated requests to Google APIs
    req.oauthToken = token;
    
    next();
};