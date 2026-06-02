import type { SandboxPolicy } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import {
  buildVmMountPlan,
  fingerprintVmMountPlan,
  MOUNT_PLAN_SCHEMA_VERSION,
  type MountPlanHost
} from '../../src/mount-plan.ts';
import { toGuestPath } from '../../src/winpath.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; policy: SandboxPolicy }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'monad-mount-plan-')));
  roots.push(root);
  await mkdir(join(root, 'work', '.ssh'), { recursive: true });
  return {
    root,
    policy: {
      writableRoots: [root],
      readDenyRoots: [join(root, 'work', '.ssh')]
    }
  };
}

test('places a nested deny after the writable share', async () => {
  const { root, policy } = await fixture();

  const plan = await buildVmMountPlan(policy);

  expect(plan.shares.map(({ hostPath, guestPath, readOnly }) => ({ hostPath, guestPath, readOnly }))).toEqual([
    { hostPath: root, guestPath: toGuestPath(root), readOnly: false }
  ]);
  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: posix.join(toGuestPath(root), 'work', '.ssh') }]);
});

test('fingerprint is deterministic and changes with the canonical mount plan', () => {
  const plan = {
    shares: [{ tag: 'w0', hostPath: '/work', guestPath: '/work', readOnly: false }],
    overlays: [{ kind: 'deny-directory' as const, target: '/work/.ssh' }]
  };

  expect(MOUNT_PLAN_SCHEMA_VERSION).toBe(1);
  expect(fingerprintVmMountPlan(plan)).toBe(fingerprintVmMountPlan(structuredClone(plan)));
  expect(fingerprintVmMountPlan(plan)).not.toBe(
    fingerprintVmMountPlan({ ...plan, overlays: [{ kind: 'deny-directory', target: '/work/.gnupg' }] })
  );
});

test('a missing nested deny covers the first missing component', async () => {
  const { root } = await fixture();

  const plan = await buildVmMountPlan({
    writableRoots: [root],
    readDenyRoots: [join(root, 'work', 'missing', 'deeper')]
  });

  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: posix.join(toGuestPath(root), 'work', 'missing') }]);
});

test('a symlink that escapes an allowed share fails closed', async () => {
  const { root } = await fixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'monad-mount-outside-')));
  roots.push(outside);
  await writeFile(join(outside, 'secret'), 'secret');
  await symlink(outside, join(root, 'work', 'escape'));

  await expect(
    buildVmMountPlan({ writableRoots: [root], readDenyRoots: [join(root, 'work', 'escape', 'secret')] })
  ).rejects.toThrow('escapes mounted root');
});

test('canonical host roots preserve the caller-visible guest path', async () => {
  const container = await realpath(await mkdtemp(join(tmpdir(), 'monad-mount-alias-')));
  roots.push(container);
  const canonical = join(container, 'canonical');
  const alias = join(container, 'alias');
  await mkdir(join(canonical, '.ssh'), { recursive: true });
  await symlink(canonical, alias);

  const plan = await buildVmMountPlan({ writableRoots: [alias], readDenyRoots: [join(alias, '.ssh')] });

  expect(plan.shares[0]).toEqual({
    tag: 'w0',
    hostPath: canonical,
    guestPath: toGuestPath(alias),
    readOnly: false
  });
  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: posix.join(toGuestPath(alias), '.ssh') }]);
});

test('overlapping shares deny every guest alias for the same canonical target', async () => {
  const container = await realpath(await mkdtemp(join(tmpdir(), 'monad-mount-overlap-')));
  roots.push(container);
  const parent = join(container, 'parent');
  const child = join(parent, 'child');
  const childAlias = join(container, 'child-alias');
  await mkdir(join(child, '.ssh'), { recursive: true });
  await symlink(child, childAlias);

  const plan = await buildVmMountPlan({
    writableRoots: [parent, childAlias],
    readDenyRoots: [join(childAlias, '.ssh')]
  });

  expect(plan.shares).toEqual([
    { tag: 'w0', hostPath: parent, guestPath: toGuestPath(parent), readOnly: false },
    { tag: 'w1', hostPath: child, guestPath: toGuestPath(child), readOnly: false }
  ]);
  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: posix.join(toGuestPath(parent), 'child', '.ssh') }]);
});

test('Windows shares keep host paths while policy targets use translated guest paths', async () => {
  const kinds = new Map<string, 'file' | 'directory'>([
    ['c:\\work', 'directory'],
    ['c:\\work\\.ssh', 'directory']
  ]);
  const host: MountPlanHost = {
    platform: 'win32',
    async realpath(path) {
      const normalized = win32.normalize(path).toLowerCase();
      if (!kinds.has(normalized)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return normalized;
    },
    async kind(path) {
      return kinds.get(win32.normalize(path).toLowerCase()) ?? 'missing';
    },
    async assertReadable(path) {
      if (!kinds.has(win32.normalize(path).toLowerCase())) throw new Error('unreadable');
    }
  };

  const plan = await buildVmMountPlan(
    {
      writableRoots: ['C:\\work'],
      readDenyRoots: ['C:\\work\\.ssh']
    },
    host
  );

  expect(plan.shares).toEqual([{ tag: 'w0', hostPath: 'c:\\work', guestPath: '/mnt/c/work', readOnly: false }]);
  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: '/mnt/c/work/.ssh' }]);
});
