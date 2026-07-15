import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaselineCache, BaselineCacheError } from '../../src/baseline/cache.ts';

const manifest = {
  identity: 'identity-a',
  reuseDigest: 'reuse-a',
  driver: { kind: 'qemu', version: '9.0', toolchain: 'tools-a', arch: 'x64' },
  guest: { agent: 'agent-a', observer: 'observer-a', protocol: 5, ignition: '3.4.0', mountPlan: 'mount-a' },
  topology: { cpus: 2, memoryMiB: 2048, digest: 'topology-a' },
  bootEpoch: 'epoch-a'
};

test('publishes owner-only, validates digests, and reopens a baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 4, maxBytes: 1024 });
  const artifact = await cache.publish(manifest, async (dir) => {
    writeFileSync(join(dir, 'state.bin'), 'trusted-state');
    return ['state.bin'];
  });
  expect(statSync(root).mode & 0o077).toBe(0);
  expect(statSync(artifact.dir).mode & 0o077).toBe(0);
  expect(await cache.get('identity-a')).toMatchObject({ identity: 'identity-a', byteSize: 13 });
  expect(JSON.parse(readFileSync(artifact.manifestPath, 'utf8')).artifacts[0]).toMatchObject({ name: 'state.bin' });
});

test('digest corruption invalidates the artifact before restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 4, maxBytes: 1024 });
  const artifact = await cache.publish(manifest, async (dir) => {
    writeFileSync(join(dir, 'state.bin'), 'trusted-state');
    return ['state.bin'];
  });
  writeFileSync(join(artifact.dir, 'state.bin'), 'corrupt');
  expect(await cache.get('identity-a')).toBeUndefined();
  expect(existsSync(artifact.dir)).toBe(false);
});

test('capture lease admits one writer and restore lease protects an active artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 1, maxBytes: 1024 });
  const lease = await cache.acquireCaptureLease('identity-a');
  await expect(cache.acquireCaptureLease('identity-a')).rejects.toMatchObject({ code: BaselineCacheError.LEASED });
  await lease.release();
  await cache.publish(manifest, async (dir) => {
    writeFileSync(join(dir, 'state.bin'), 'a');
    return ['state.bin'];
  });
  const restore = await cache.acquireRestoreLease('identity-a');
  expect(restore?.artifact).toMatchObject({ byteSize: 1, identity: 'identity-a' });
  await cache.invalidate('identity-a');
  expect(await cache.get('identity-a')).toMatchObject({ byteSize: 1, identity: 'identity-a' });
  await restore?.release();
  await cache.invalidate('identity-a');
  expect(await cache.get('identity-a')).toBeUndefined();
});

test('LRU evicts only inactive artifacts to count and byte bounds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 1, maxBytes: 4 });
  for (const identity of ['a', 'b']) {
    await cache.publish({ ...manifest, identity, bootEpoch: `epoch-${identity}` }, async (dir) => {
      writeFileSync(join(dir, 'state.bin'), identity.repeat(3));
      return ['state.bin'];
    });
  }
  expect(await cache.get('a')).toBeUndefined();
  expect(await cache.get('b')).toMatchObject({ byteSize: 3, identity: 'b' });
});

test('malformed and unknown manifest fields are rejected and removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 4, maxBytes: 1024 });
  const artifact = await cache.publish(manifest, async (dir) => {
    writeFileSync(join(dir, 'state.bin'), 'a');
    return ['state.bin'];
  });
  const parsed = JSON.parse(readFileSync(artifact.manifestPath, 'utf8')) as Record<string, unknown>;
  parsed.unknown = true;
  writeFileSync(artifact.manifestPath, JSON.stringify(parsed));
  expect(await cache.get('identity-a')).toBeUndefined();
});

test('crash cleanup removes only stale marker-owned temporary resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-cache-'));
  const stale = join(root, '.capture-stale.lock');
  const active = join(root, '.capture-active.lock');
  const unrelated = join(root, 'unrelated');
  for (const path of [stale, active, unrelated]) mkdirSync(path);
  writeFileSync(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, token: 'stale' }));
  writeFileSync(join(active, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'active' }));
  const cache = new BaselineCache(root, { maxInactiveArtifacts: 4, maxBytes: 1024 });
  await cache.cleanupTemporary();
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(active)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
});
