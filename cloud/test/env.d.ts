// The bindings the tests see: the Worker's own, plus the migrations to apply.
import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/types';

declare global {
    namespace Cloudflare {
        interface Env extends WorkerEnv {
            TEST_MIGRATIONS: D1Migration[];
        }
    }
}
