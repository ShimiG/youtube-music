module.exports = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) {
        return res.status(401).json({ error: "Access Denied. No token provided." });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token || token === 'null' || token === 'undefined') {
        return res.status(401).json({ error: "Invalid token format. User is not authenticated." });
    }

    req.oauthToken = token;
    
    next();
};