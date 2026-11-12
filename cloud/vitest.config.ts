// Tests run inside the Workers runtime (workerd, through Miniflare), against a
// local D1 database created from the real migrations.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
    const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
    return {
        plugins: [
            cloudflareTest({
                wrangler: { configPath: './wrangler.jsonc' },
                miniflare: {
                    bindings: {
                        TEST_MIGRATIONS: migrations,
                        // Test values only; real ones are set with `wrangler secret put`.
                        JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
                        REGISTRATION_CODE: 'let-me-in',
                        AUTH_PEPPER: 'test-pepper'
                    }
                }
            })
        ],
        test: {
            include: ['test/**/*.test.ts'],
            setupFiles: ['./test/setup.ts']
        }
    };
});
