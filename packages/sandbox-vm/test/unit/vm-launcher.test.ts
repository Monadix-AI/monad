import { expect, test } from 'bun:test';

import { vmLauncher } from '../../src/index.ts';

test('vm launcher declares the macOS heavy backend contract', () => {
  expect(vmLauncher.kind).toBe('vm');
  expect(vmLauncher.platforms).toEqual(['darwin', 'linux', 'win32']);
  // REMOTE model: runs the process (spawn), does not rewrite argv (wrap).
  expect(vmLauncher.wrap).toBeUndefined();
  // Declares strong containment for honest boot logging.
  expect(vmLauncher.enforces).toEqual({
    writeConfine: true,
    readDeny: true,
    net: ['none', 'filtered', 'unrestricted']
  });
});

test('spawn before prepare throws rather than running unconfined', () => {
  // isAvailable may be false on non-darwin CI; spawn must still fail closed (not silently host-run).
  expect(() => vmLauncher.spawn?.(['echo', 'hi'], { sessionId: 's' }, {})).toThrow();
});
