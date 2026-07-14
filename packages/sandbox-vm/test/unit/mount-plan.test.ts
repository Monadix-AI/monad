import type { SandboxPolicy } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { buildVmMountPlan, type MountPlanHost } from '../../src/mount-plan.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; policy: SandboxPolicy }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'monad-mount-plan-')));
  roots.push(root);
  await mkdir(join(root, 'work', '.ssh'), { recursive: true });
  await mkdir(join(root, 'masks'), { recursive: true });
  await writeFile(join(root, 'work', 'token'), 'real-secret');
  await writeFile(join(root, 'masks', 'token'), 'fake-sentinel');
  return {
    root,
    policy: {
      writableRoots: [root],
      readDenyRoots: [join(root, 'work', '.ssh')],
      maskedFiles: [{ real: join(root, 'work', 'token'), fake: join(root, 'masks', 'token') }]
    }
  };
}

test('orders fake-store protection, nested deny, and mask after the writable share', async () => {
  const { root, policy } = await fixture();

  const plan = await buildVmMountPlan(policy);

  expect(plan.shares.map(({ hostPath, guestPath, readOnly }) => ({ hostPath, guestPath, readOnly }))).toEqual([
    { hostPath: root, guestPath: root, readOnly: false },
    { hostPath: join(root, 'masks'), guestPath: '/run/monad/masks/0', readOnly: true }
  ]);
  expect(plan.overlays).toEqual([
    { kind: 'protect-store', source: '/run/monad/masks/0', target: join(root, 'masks') },
    { kind: 'deny-directory', target: join(root, 'work', '.ssh') },
    { kind: 'mask-file', source: '/run/monad/masks/0/token', target: join(root, 'work', 'token') }
  ]);
});

test('a missing nested deny covers the first missing component', async () => {
  const { root } = await fixture();

  const plan = await buildVmMountPlan({
    writableRoots: [root],
    readDenyRoots: [join(root, 'work', 'missing', 'deeper')]
  });

  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: join(root, 'work', 'missing') }]);
});

test('deny wins over a mask at the same canonical target', async () => {
  const { root, policy } = await fixture();
  policy.readDenyRoots = [join(root, 'work', 'token')];

  const plan = await buildVmMountPlan(policy);

  expect(plan.overlays.some((overlay) => overlay.kind === 'mask-file')).toBe(false);
  expect(plan.overlays.some((overlay) => overlay.kind === 'deny-file')).toBe(true);
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

  expect(plan.shares[0]).toEqual({ tag: 'w0', hostPath: canonical, guestPath: alias, readOnly: false });
  expect(plan.overlays).toEqual([{ kind: 'deny-directory', target: join(alias, '.ssh') }]);
});

test('missing and non-regular fake mask sources fail closed', async () => {
  const { root } = await fixture();
  await expect(
    buildVmMountPlan({ maskedFiles: [{ real: join(root, 'token'), fake: join(root, 'missing') }] })
  ).rejects.toThrow('mask source');
  await expect(
    buildVmMountPlan({ maskedFiles: [{ real: join(root, 'token'), fake: join(root, 'masks') }] })
  ).rejects.toThrow('regular file');
});

test('Windows shares keep host paths while policy targets use translated guest paths', async () => {
  const kinds = new Map<string, 'file' | 'directory'>([
    ['c:\\work', 'directory'],
    ['c:\\work\\.ssh', 'directory'],
    ['c:\\fake', 'directory'],
    ['c:\\fake\\token', 'file'],
    ['c:\\work\\token', 'file']
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
      readDenyRoots: ['C:\\work\\.ssh'],
      maskedFiles: [{ real: 'C:\\work\\token', fake: 'C:\\fake\\token' }]
    },
    host
  );

  expect(plan.shares).toEqual([
    { tag: 'w0', hostPath: 'c:\\work', guestPath: '/mnt/c/work', readOnly: false },
    { tag: 'm0', hostPath: 'c:\\fake', guestPath: '/run/monad/masks/0', readOnly: true }
  ]);
  expect(plan.overlays).toEqual([
    { kind: 'deny-directory', target: '/mnt/c/work/.ssh' },
    { kind: 'mask-file', source: '/run/monad/masks/0/token', target: '/mnt/c/work/token' }
  ]);
});
