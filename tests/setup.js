// Runs before the test suite. Sets a deterministic JWT secret so tests can sign
// tokens the app will accept, without loading the developer's real .env.
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.NODE_ENV = 'test';
// Never let a test run try to download a new yt-dlp.
process.env.YTDLP_AUTO_UPDATE = 'false';
// Deterministic token-encryption key, so tests never create a .token-key file.
process.env.TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// Dummy Google OAuth client, so YouTube counts as configured (isAvailable /
// the connect URL). Never a real credential.
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
