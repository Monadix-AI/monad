import { expect, test } from 'bun:test';

import { VmBackendNotImplementedError, vmLauncher } from '../../src/index.ts';

test('vm launcher is a heavy skeleton: declared kind, unavailable, spawn throws', () => {
  expect(vmLauncher.kind).toBe('vm');
  // Unavailable until the subsystem lands — this is what makes `backend:'vm'` fall back to light.
  expect(vmLauncher.isAvailable?.()).toBe(false);
  // REMOTE model with no wrap(); invoking spawn surfaces the not-implemented error rather than
  // silently running unconfined.
  expect(vmLauncher.wrap).toBeUndefined();
  expect(() => vmLauncher.spawn?.([], {}, {})).toThrow(VmBackendNotImplementedError);
});
