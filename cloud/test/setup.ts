// Every test starts from the real schema and no data.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM google_links'),
        env.DB.prepare('DELETE FROM records'),
        env.DB.prepare('DELETE FROM users')
    ]);
});
