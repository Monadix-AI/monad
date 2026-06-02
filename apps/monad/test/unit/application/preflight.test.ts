import { expect, test } from 'bun:test';

import { resolveDaemonMode } from '#/application/preflight.ts';

test('daemon preflight selects ACP bridge before daemon startup', () => {
  expect(resolveDaemonMode(['bun', 'main.ts', '--acp'])).toBe('acp');
  expect(resolveDaemonMode(['bun', 'main.ts', '--stdio'])).toBe('daemon');
});
