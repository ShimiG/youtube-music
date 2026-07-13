require('dotenv').config();

const app = require('./app');
const initDB = require('./config/db');

const PORT = process.env.PORT || 3000;

// Fail fast if a required secret is missing, instead of crashing later on the
// first request that needs it.
function validateEnv() {
    const missing = [];
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
        console.warn('Warning: JWT_SECRET is short; use at least 32 random characters.');
    }
    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        console.error('Copy .env.example to .env and fill in the values.');
        process.exit(1);
    }
}

validateEnv();

initDB()
    .then((db) => {
        app.locals.db = db;
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Failed to initialize database:', err);
        process.exit(1);
    });
