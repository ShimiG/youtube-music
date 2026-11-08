const jwt = require('jsonwebtoken');

// Verifies OUR OWN login token (JWT). On success it sets req.userId from the
// signed payload — the client cannot choose its own id, because it cannot forge
// a signature without JWT_SECRET. Use this on every route backed by our database.
module.exports = (req, res, next) => {
    const authHeader = req.header('Authorization');
    if (!authHeader) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token || token === 'null' || token === 'undefined') {
        return res.status(401).json({ error: 'Access denied. Malformed token.' });
    }

    try {
        // Pin the algorithm (never trust the token header's `alg`).
        const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        // Other tokens signed with the same secret (the OAuth `state`, which
        // travels through the browser URL) carry a different `purpose` and
        // must never work as a login session.
        if (payload.purpose !== undefined && payload.purpose !== 'session') throw new Error('wrong token purpose');
        if (!Number.isInteger(payload.userId) || payload.userId <= 0) throw new Error('bad subject');
        req.userId = payload.userId;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
};
