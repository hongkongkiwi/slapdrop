import type { D1Migration } from '@cloudflare/vitest-plugin'
import type { Env as SlapDropEnv } from '../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends SlapDropEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
