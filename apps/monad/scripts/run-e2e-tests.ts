import { dirname } from 'node:path';

import { DAEMON_E2E_TIMEOUT_BUDGET } from './e2e-timeout-budget.ts';

const test = Bun.spawn(
  [
    'bun',
    '../../scripts/bun-test.ts',
    'test/e2e/',
    `--timeout=${DAEMON_E2E_TIMEOUT_BUDGET.testCaseMs}`,
    '--path-ignore-patterns=**/live-*.test.ts',
    '--path-ignore-patterns=**/*.local.test.ts',
    '--monad-shards=auto',
    '--only-failures'
  ],
  { cwd: dirname(import.meta.dir), env: Bun.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
);

process.exit(await test.exited);
