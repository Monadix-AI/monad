import { expect, test } from 'bun:test';

import { formatDaemonUnreachableHint } from '../../src/commands/tui.ts';

test('formatDaemonUnreachableHint uses the resolved daemon URL', () => {
  expect(formatDaemonUnreachableHint('http://127.0.0.1:52749')).toContain('(http://127.0.0.1:52749)');
});
