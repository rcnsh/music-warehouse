import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as WorkerEnv, RecentlyPlayedResponse } from '../src/types';

// `cloudflare:test` types its `env` export as `Cloudflare.Env`. Declare it here
// as the Worker's own Env plus the bindings vitest.config.ts injects for tests.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_FIXTURE: RecentlyPlayedResponse;
    }
  }
}

export {};
