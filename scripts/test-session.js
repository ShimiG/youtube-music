#!/usr/bin/env node
// A session for testing the API without a cloud service.
//
// People sign in with their cloud account, which needs a deployed cloud
// service. Automated checks of this server (the security review, a quick
// look with curl) need a signed-in account without one. This makes a
// throwaway account straight in the database and prints a session for it:
//
//   MUSIC_DATA_DIR=/tmp/scratch JWT_SECRET=<the server's> node scripts/test-session.js alice
//
// Run it with the same MUSIC_DATA_DIR and JWT_SECRET as the server under
// test. The first account made is the installation's owner. It is a tool for
// whoever already holds the data folder and the secret, which is everything
// there is to hold; it adds no way in for anyone else. The account has no
// cloud sign-in, so the app's own screens send it back to the sign-in page:
// it is for calling the API.
const path = require('path');

async function main() {
    const name = process.argv[2];
    if (!name || !/^[A-Za-z0-9_.-]{1,32}$/.test(name)) {
        console.error('Usage: node scripts/test-session.js <account name>');
        process.exit(2);
    }
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
        console.error('Set JWT_SECRET to the secret the server under test runs with (32 characters or more).');
        process.exit(2);
    }
    const { dataDir } = require('../services/paths');
    const quiet = console.log;
    console.log = () => {};
    const db = await require('../config/db')(path.join(dataDir(), 'database.sqlite'));
    console.log = quiet;
    let row = await db.get('SELECT id FROM users WHERE username = ?', [name]);
    if (!row) row = { id: (await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [name, '!'])).lastID };
    await db.close();
    const { issueToken } = require('../controllers/UserController');
    console.log(JSON.stringify({ userId: row.id, username: name, token: issueToken(row.id) }));
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
