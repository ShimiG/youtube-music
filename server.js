import dotenv from 'dotenv';
import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import searchRoute from './routes/search.js';
import authRoutes from './routes/auth.js';
import playlistRoute from './routes/playlist.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors());

// --- API ROUTES ---
app.use('/search', searchRoute);
app.use('/playlist', playlistRoute);
app.use('/auth', authRoutes);

// --- SERVE REACT BUILD ---
app.use(express.static(path.join(__dirname, 'dist')));

// Fallback: Serve index.html for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- DATABASE CONNECTION ---
const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Failed:', error.message);
        process.exit(1);
    }
};

// --- START SERVER ---
const PORT = process.env.PORT || 3000;

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
});