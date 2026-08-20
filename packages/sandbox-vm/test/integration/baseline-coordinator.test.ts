import type { VmBaselineArtifact, VmBaselineDriver, VmHandle, VmSpec } from '../../src/driver/vfkit.ts';

import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaselineCache } from '../../src/baseline/cache.ts';
import { BaselineCoordinator } from '../../src/baseline/coordinator.ts';

const spec = {} as VmSpec;
const manifest = {
  identity: 'identity-a',
  reuseDigest: 'reuse-a',
  driver: { kind: 'fake', version: '1', toolchain: 'tools', arch: 'arm64' },
  guest: { agent: 'agent-a', observer: 'observer-a', protocol: 5, ignition: '3.4.0', mountPlan: 'mount-a' },
  topology: { cpus: 2, memoryMiB: 2048, digest: 'topology-a' }
};

function handle(id: number): VmHandle & { id: number; stopped: boolean } {
  const value = {
    id,
    stopped: false,
    pid: id,
    exited: new Promise<number>(() => {}),
    diagnostics: {} as VmHandle['diagnostics'],
    async stop() {
      value.stopped = true;
    }
  };
  return value;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'baseline-coordinator-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 4, maxBytes: 1024 });
  let cold = 0;
  let restored = 0;
  let captured = 0;
  const driver: VmBaselineDriver = {
    kind: 'fake',
    baselineSupported: true,
    async boot() {
      return handle(++cold);
    },
    async captureBaseline(_spec, _handle, dir) {
      captured++;
      writeFileSync(join(dir, 'state.bin'), 'state');
      return ['state.bin'];
    },
    async restoreBaseline(_spec: VmSpec, _artifact: VmBaselineArtifact) {
      return handle(100 + ++restored);
    },
    async invalidateBaseline() {}
  };
  const coordinator = new BaselineCoordinator(cache);
  const acquire = (confirm = async () => {}) =>
    coordinator.acquire({
      enabled: true,
      identity: manifest.identity,
      manifest,
      spec,
      driver,
      coldBoot: () => driver.boot(spec),
      prepare: async () => ({ bootEpoch: 'epoch-a', agentDigest: 'agent-a' }),
      confirm
    });
  return { acquire, cache, counts: () => ({ cold, restored, captured }) };
}

test('captures once before the first workload and restores on reconstruction', async () => {
  const f = fixture();
  expect((await f.acquire()).source).toBe('cold');
  expect((await f.acquire()).source).toBe('restored');
  expect(f.counts()).toEqual({ cold: 1, restored: 1, captured: 1 });
});

test('restore handshake failure invalidates once and cold boots once', async () => {
  const f = fixture();
  await f.acquire();
  let calls = 0;
  const result = await f.acquire(async () => {
    if (++calls === 1) throw new Error('epoch mismatch');
  });
  expect(result.source).toBe('cold');
  expect(f.counts()).toEqual({ cold: 2, restored: 1, captured: 2 });
});
