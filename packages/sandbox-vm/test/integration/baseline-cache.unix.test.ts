import { expect, test } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaselineCache } from '../../src/baseline/cache.ts';

test('published baseline directories are accessible only by their owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-mode-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 1, maxBytes: 1024 });
  const artifact = await cache.publish(
    {
      identity: 'identity-a',
      reuseDigest: 'reuse-a',
      driver: { kind: 'qemu', version: '9.0', toolchain: 'tools-a', arch: 'x64' },
      guest: { agent: 'agent-a', observer: 'observer-a', protocol: 5, ignition: '3.4.0', mountPlan: 'mount-a' },
      topology: { cpus: 2, memoryMiB: 2048, digest: 'topology-a' },
      bootEpoch: 'epoch-a'
    },
    async (directory) => {
      writeFileSync(join(directory, 'state.bin'), 'trusted-state');
      return ['state.bin'];
    }
  );

  expect({
    artifactMode: statSync(artifact.dir).mode & 0o077,
    rootMode: statSync(root).mode & 0o077
  }).toEqual({ artifactMode: 0, rootMode: 0 });
});
