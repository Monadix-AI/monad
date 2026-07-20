import { expect, test } from 'bun:test';

import { terminalOutputSyncPlan } from '../../src/features/workplace/cli/terminal-output-sync.ts';

test('terminalOutputSyncPlan replays changed snapshots instead of appending stale terminal state', () => {
  expect(terminalOutputSyncPlan('open', 'opening')).toEqual({
    kind: 'replay',
    text: 'opening',
    writtenOutput: 'opening'
  });
});

test('terminalOutputSyncPlan replays truncated snapshots', () => {
  expect(terminalOutputSyncPlan('opening browser', 'browser ready')).toEqual({
    kind: 'replay',
    text: 'browser ready',
    writtenOutput: 'browser ready'
  });
  expect(terminalOutputSyncPlan('abcdef', 'cdef')).toEqual({
    kind: 'replay',
    text: 'cdef',
    writtenOutput: 'cdef'
  });
});
