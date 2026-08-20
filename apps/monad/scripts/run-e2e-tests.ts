import { dirname, join } from 'node:path';

import { DAEMON_E2E_TIMEOUT_BUDGET } from './e2e-timeout-budget.ts';

const root = dirname(import.meta.dir);
const sharedArgs = [
  'bun',
  '../../scripts/bun-test.ts',
  `--timeout=${DAEMON_E2E_TIMEOUT_BUDGET.testCaseMs}`,
  '--path-ignore-patterns=**/live-*.test.ts',
  '--path-ignore-patterns=**/*.local.test.ts',
  '--only-failures'
];

async function run(args: string[]): Promise<number> {
  const test = Bun.spawn(args, {
    cwd: root,
    env: Bun.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  return await test.exited;
}

const shardedExitCode = await run([
  ...sharedArgs,
  'test/e2e/',
  '--path-ignore-patterns=**/acp-stdio.test.ts',
  '--monad-shards=auto'
]);

// This case starts another Bun process and is sensitive to scheduler starvation while every E2E
// shard is also starting daemon subprocess trees. It remains part of the first pass, in a serial lane.
const stdioExitCode = await run([...sharedArgs, join('test', 'e2e', 'acp-stdio.test.ts')]);

process.exit(shardedExitCode !== 0 ? shardedExitCode : stdioExitCode);
