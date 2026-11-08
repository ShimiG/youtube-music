const fs = require('fs');
const os = require('os');
const path = require('path');
const tokenCrypto = require('../services/tokenCrypto');

const { encrypt, decrypt, isEncrypted, migratePlaintextTokens, _resetKey } = tokenCrypto;

afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    delete process.env.TOKEN_KEY_FILE;
    _resetKey();
});

describe('token encryption at rest', () => {
    it('round-trips a token and never stores the plaintext', () => {
        const stored = encrypt('ya29.secret-access-token');
        expect(isEncrypted(stored)).toBe(true);
        expect(stored).not.toContain('secret-access-token');
        expect(decrypt(stored)).toBe('ya29.secret-access-token');
    });

    it('uses a fresh IV per value, so equal tokens do not produce equal ciphertext', () => {
        expect(encrypt('same')).not.toBe(encrypt('same'));
    });

    it('passes null and undefined through so optional columns stay NULL', () => {
        expect(encrypt(null)).toBeNull();
        expect(decrypt(null)).toBeNull();
        expect(encrypt(undefined)).toBeUndefined();
    });

    it('does not double-encrypt', () => {
        const once = encrypt('t');
        expect(encrypt(once)).toBe(once);
    });

    it('returns legacy plaintext values unchanged', () => {
        expect(decrypt('legacy-plain-token')).toBe('legacy-plain-token');
    });

    it('returns null for a tampered value instead of throwing', () => {
        const stored = encrypt('abc');
        const tampered = stored.slice(0, -2) + (stored.endsWith('A') ? 'BB' : 'AA');
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(decrypt(tampered)).toBeNull();
        console.error.mockRestore();
    });

    it('returns null when the key changed (connection treated as disconnected)', () => {
        const stored = encrypt('abc');
        process.env.TOKEN_ENCRYPTION_KEY = 'f'.repeat(64);
        _resetKey();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(decrypt(stored)).toBeNull();
        console.error.mockRestore();
    });

    it('rejects a key that is not 32 bytes', () => {
        process.env.TOKEN_ENCRYPTION_KEY = 'too-short';
        _resetKey();
        expect(() => encrypt('x')).toThrow(/32 bytes/);
    });

    it('creates an owner-only key file when no key is configured, and reuses it', () => {
        delete process.env.TOKEN_ENCRYPTION_KEY;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokkey-'));
        process.env.TOKEN_KEY_FILE = path.join(dir, '.token-key');
        _resetKey();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const stored = encrypt('persist-me');
        console.warn.mockRestore();
        expect(fs.existsSync(process.env.TOKEN_KEY_FILE)).toBe(true);
        if (process.platform !== 'win32') {
            expect(fs.statSync(process.env.TOKEN_KEY_FILE).mode & 0o777).toBe(0o600);
        }
        _resetKey();
        expect(decrypt(stored)).toBe('persist-me');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('migratePlaintextTokens', () => {
    it('encrypts plaintext rows in user_connections and app_tokens, and skips encrypted ones', async () => {
        const already = encrypt('done');
        const db = {
            all: jest.fn()
                .mockResolvedValueOnce([
                    { k: 1, access_token: 'plain-a', refresh_token: 'plain-r' },
                    { k: 2, access_token: already, refresh_token: null }
                ])
                .mockResolvedValueOnce([{ k: 'soundcloud', access_token: 'app-plain', refresh_token: null }]),
            run: jest.fn().mockResolvedValue({})
        };
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const count = await migratePlaintextTokens(db);
        console.log.mockRestore();

        expect(count).toBe(2);
        expect(db.run).toHaveBeenCalledTimes(2);
        const [sql1, params1] = db.run.mock.calls[0];
        expect(sql1).toContain('UPDATE user_connections');
        expect(params1.slice(0, 2).map(decrypt)).toEqual(['plain-a', 'plain-r']);
        expect(params1[0]).toMatch(/^enc:v1:/);
        expect(params1[2]).toBe(1);
        const [sql2, params2] = db.run.mock.calls[1];
        expect(sql2).toContain('UPDATE app_tokens');
        expect(decrypt(params2[0])).toBe('app-plain');
        expect(params2[1]).toBeNull();
    });
});
