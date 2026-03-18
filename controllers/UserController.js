const crypto = require('crypto');
const bcrypt = require('bcrypt');

const hashPassword = async (password) => {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
};

const registerUser = async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const db = req.app.locals.db; 

    try {
        const hashedPassword = await hashPassword(password);
        const result = await db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword]);

        res.status(201).json({ userId: result.lastID, username });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: "Username already exists" });
        }
        console.error("Registration error:", err);
        return res.status(500).json({ error: "Database error" });
    }
};

const loginUser = async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const db = req.app.locals.db;

    try {
        const row = await db.get(`SELECT id, username, password FROM users WHERE username = ?`, [username]);
        
        if (!row) return res.status(401).json({ error: "Invalid username or password" });

        const passwordMatches = await bcrypt.compare(password, row.password);
        if (!passwordMatches) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        res.json({ userId: row.id, username: row.username });
    } catch (err) {
        console.error("Login error:", err);
        return res.status(500).json({ error: "Database error" });
    }
};

module.exports = {
    registerUser,
    loginUser
};