const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 1. REGISTER ROUTE
router.post('/register', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Check if user already exists
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ error: "Username taken" });

        // Hash the password (Encryption)
        // 10 is the "Salt Rounds" (how hard it is to crack)
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create and Save
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
        // Check if user exists
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ error: "User not found" });

        // Check if password matches (Compare plain text vs. Hash)
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Invalid password" });

        // Generate the Token (The "ID Badge")
        // We put the User's ID inside the token so we know who they are later
        const token = jwt.sign(
            { userId: user._id }, 
            process.env.JWT_SECRET || 'secret_key_123', // In prod, use .env!
            { expiresIn: '1h' } // Token expires in 1 hour
        );

        // Send the token to the frontend
        res.json({ token, username: user.username });

    } catch (error) {
        res.status(500).json({ error: "Login failed" });
    }
});

module.exports = router;