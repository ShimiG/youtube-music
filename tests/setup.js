// Runs before the test suite. Sets a deterministic JWT secret so tests can sign
// tokens the app will accept, without loading the developer's real .env.
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.NODE_ENV = 'test';
