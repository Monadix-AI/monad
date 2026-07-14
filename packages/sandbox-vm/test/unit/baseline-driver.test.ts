import { expect, test } from 'bun:test';

import { hypervDriver } from '../../src/driver/hyperv.ts';
import { qemuDriver } from '../../src/driver/qemu.ts';
import { isBaselineDriver, vfkitDriver } from '../../src/driver/vfkit.ts';

test('drivers declare baseline capability without platform branching in callers', () => {
  expect(isBaselineDriver(vfkitDriver)).toBe(false);
  expect(isBaselineDriver(qemuDriver)).toBe(false);
  expect(isBaselineDriver(hypervDriver)).toBe(false);
  expect(vfkitDriver.baselineSupported).toBe(false);
  expect(qemuDriver.baselineSupported).toBe(true);
  expect(hypervDriver.baselineSupported).toBe(true);
});
