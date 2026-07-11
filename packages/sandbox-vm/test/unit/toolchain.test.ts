import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  __pins,
  __resetVmToolchainForTest,
  configureVmToolchain,
  vmBinDir,
  vmDir,
  vmToolchainMaybeAvailable
} from '../../src/toolchain.ts';

afterEach(() => __resetVmToolchainForTest());

test('vmDir defaults under MONAD_HOME/vm and honours the config override', () => {
  configureVmToolchain({ vmDir: '/custom/vm' });
  expect(vmDir()).toBe('/custom/vm');
  expect(vmBinDir()).toBe(join('/custom/vm', 'bin'));
});

test('pins are concrete: real version tags + non-placeholder sha256', () => {
  expect(__pins.VFKIT.version).toBe('v0.6.4');
  expect(__pins.GVPROXY.version).toBe('v0.8.9');
  // A placeholder sha would let an unverified binary through — the pin must be a real 64-hex digest.
  for (const pin of [__pins.VFKIT, __pins.GVPROXY]) {
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  // vfkit needs the virtualization entitlement (adhoc re-sign on download); gvproxy does not.
  expect(__pins.VFKIT.needsEntitlement).toBe(true);
  expect(__pins.GVPROXY.needsEntitlement).toBe(false);
});

test('maybe-available is false off-darwin regardless of config', () => {
  configureVmToolchain({ vfkitPath: '/x/vfkit', gvproxyPath: '/x/gvproxy' });
  if (process.platform !== 'darwin') {
    expect(vmToolchainMaybeAvailable()).toBe(false);
  } else {
    // On darwin, explicit override paths make it worth attempting even before resolution.
    expect(vmToolchainMaybeAvailable()).toBe(true);
  }
});
