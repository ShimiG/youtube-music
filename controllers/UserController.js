const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 12;
const TOKEN_TTL = '7d';

const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

const issueToken = (userId) =>
    jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });

// Basic guard so junk/oversized input is rejected before it reaches the DB.
const validateCredentials = (username, password) => {
    if (typeof username !== 'string' || typeof password !== 'string') return 'Username and password must be text';
    if (username.length < 3 || username.length > 32) return 'Username must be 3-32 characters';
    if (password.length < 8 || password.length > 128) return 'Password must be 8-128 characters';
    return null;
};

const registerUser = async (req, res, next) => {
    const { username, password } = req.body || {};
    const validationError = validateCredentials(username, password);
    if (validationError) return res.status(400).json({ error: validationError });

    const db = req.app.locals.db;

    try {
        const hashedPassword = await hashPassword(password);
        const result = await db.run(
            `INSERT INTO users (username, password) VALUES (?, ?)`,
            [username, hashedPassword]
        );
        const token = issueToken(result.lastID);
        res.status(201).json({ token, userId: result.lastID, username });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Username already exists' });
        }
        next(err);
    }
};

const loginUser = async (req, res, next) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password required' });
    }

    const db = req.app.locals.db;

    try {
        const row = await db.get(`SELECT id, username, password FROM users WHERE username = ?`, [username]);

        // Always run a bcrypt comparison, even when the user does not exist, so the
        // response time does not reveal whether a username is registered.
        const hash = row ? row.password : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
        const passwordMatches = await bcrypt.compare(password, hash);

        if (!row || !passwordMatches) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = issueToken(row.id);
        res.json({ token, userId: row.id, username: row.username });
    } catch (err) {
        next(err);
    }
};

module.exports = {
    registerUser,
    loginUser
};
