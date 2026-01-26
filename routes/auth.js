import express from 'express';
import User from '../models/user.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const router = express.Router();

// 1. REGISTER ROUTE
router.post('/register', async (req, res) => {
    const { username, password } = req.body;

    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: "Username taken" });

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({ 
            username, 
            password: hashedPassword 
        });
        await newUser.save();

        res.status(201).json({ message: "User created! You can now login." });

    } catch (error) {
        res.status(500).json({ error: "Error registering user" });
    }
});

// 2. LOGIN ROUTE
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid password" });

        const token = jwt.sign(
            { userId: user._id }, 
            process.env.JWT_SECRET || 'secret_key_123',
            { expiresIn: '1h' }
        );

        res.json({ token, username: user.username });

    } catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});

export default router;