const crypto = require('crypto');

const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

const registerUser = async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const hashedPassword = hashPassword(password);
    const db = req.app.locals.db; 

    try {
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

    const hashedPassword = hashPassword(password);
    const db = req.app.locals.db;

    try {
        const row = await db.get(`SELECT id, username FROM users WHERE username = ? AND password = ?`, [username, hashedPassword]);
        
        if (!row) return res.status(401).json({ error: "Invalid username or password" });

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