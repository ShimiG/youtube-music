// Sessions and password hashes for the app's own server.
//
// A person signs in with their cloud account (controllers/cloudController.js);
// what they get back is a session for this computer's server, issued here.
// The password hash kept in `users` is only a way to let the same name and
// password in when the cloud cannot be reached. The app's own accounts
// (register and log in with a local password) no longer exist.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 12;
const TOKEN_TTL = '7d';

const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

const issueToken = (userId) =>
    jwt.sign({ userId, purpose: 'session' }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL, algorithm: 'HS256' });

module.exports = { issueToken, hashPassword };
