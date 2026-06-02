if (process.platform === 'win32') process.exit(0);

import type { ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { shellExecTool, ToolSecurityError } from '@/capabilities/tools';

const ctx = (roots?: string[]): ToolContext => ({ sessionId: 's1', sandboxRoots: roots, log: () => {} });

test('shell_exec runs in the requested cwd', async () => {
  const res = await shellExecTool.run({ command: 'pwd' }, ctx([process.cwd()]));
  expect(res.metadata.stdout.trim()).toBe(process.cwd());
});

test('shell_exec enforces a timeout', async () => {
  await expect(shellExecTool.run({ command: 'sleep 5', timeoutMs: 100 }, ctx())).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});
