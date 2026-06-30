import type { SandboxPolicy } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';

import { buildBwrapArgs } from '../../src/sandbox/bwrap.ts';

function args(policy: Partial<SandboxPolicy>): string[] {
  return buildBwrapArgs(policy as SandboxPolicy);
}

// ── baseline flags ───────────────────────────────────────────────────────────

test('always includes isolation flags', () => {
  const a = args({});
  expect(a).toContain('--unshare-user');
  expect(a).toContain('--unshare-ipc');
  expect(a).toContain('--unshare-uts');
  expect(a).toContain('--unshare-pid');
  expect(a).toContain('--new-session');
  expect(a).toContain('--die-with-parent');
});

test('always mounts /dev /proc /run', () => {
  const a = args({});
  expect(a).toContain('--dev');
  expect(a).toContain('/dev');
  expect(a).toContain('--proc');
  expect(a).toContain('/proc');
  expect(a).toContain('--tmpfs');
  expect(a).toContain('/run');
});

// ── network ──────────────────────────────────────────────────────────────────

test('net:none adds --unshare-net', () => {
  const a = args({ net: 'none' });
  expect(a).toContain('--unshare-net');
});

test('net:filtered does NOT add --unshare-net (child must reach host proxy)', () => {
  const a = args({ net: { allowProxyPort: 9999 } });
  expect(a).not.toContain('--unshare-net');
});

test('net:unrestricted does not add --unshare-net', () => {
  const a = args({ net: 'unrestricted' });
  expect(a).not.toContain('--unshare-net');
});

// ── filesystem confinement ───────────────────────────────────────────────────

test('writableRoots undefined → --bind / /', () => {
  const a = args({ writableRoots: undefined });
  const i = a.indexOf('--bind');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(a[i + 1]).toBe('/');
  expect(a[i + 2]).toBe('/');
});

test('writableRoots set → no catch-all --bind / /, but writable root is rw-bound', () => {
  const a = args({ writableRoots: ['/tmp/session'] });
  // No catch-all bind (--bind / /): find a --bind where both src and dst are "/"
  const catchAll = a.findIndex((v, i) => v === '--bind' && a[i + 1] === '/' && a[i + 2] === '/');
  expect(catchAll).toBe(-1);
  // System dirs use --ro-bind
  expect(a).toContain('--ro-bind');
  // The writable root is bound rw: --bind /tmp/session /tmp/session
  const bindIdx = a.findIndex((v, i) => v === '--bind' && a[i + 1] === '/tmp/session');
  expect(bindIdx).toBeGreaterThanOrEqual(0);
  expect(a[bindIdx + 2]).toBe('/tmp/session');
});

test('readableRoots added as --ro-bind', () => {
  const a = args({ writableRoots: ['/work'], readableRoots: ['/data/models'] });
  // --ro-bind /data/models /data/models
  const idx = a.findIndex((v, i) => v === '--ro-bind' && a[i + 1] === '/data/models');
  expect(idx).toBeGreaterThanOrEqual(0);
});

// ── readDeny ─────────────────────────────────────────────────────────────────

describe('readDenyRoots', () => {
  test('each deny path gets --dir, --perms 000, --tmpfs in that order', () => {
    const a = args({ readDenyRoots: ['/home/user/.ssh'] });
    const dirIdx = a.indexOf('--dir');
    expect(dirIdx).toBeGreaterThanOrEqual(0);
    expect(a[dirIdx + 1]).toBe('/home/user/.ssh');
    expect(a[dirIdx + 2]).toBe('--perms');
    expect(a[dirIdx + 3]).toBe('000');
    expect(a[dirIdx + 4]).toBe('--tmpfs');
    expect(a[dirIdx + 5]).toBe('/home/user/.ssh');
  });

  test('multiple readDenyRoots each get their own overlay triplet', () => {
    const denies = ['/home/user/.ssh', '/home/user/.aws', '/home/user/.gnupg'];
    const a = args({ readDenyRoots: denies });
    for (const deny of denies) {
      // Find the --dir <deny> position for this entry
      const dirIdx = a.findIndex((v, i) => v === '--dir' && a[i + 1] === deny);
      expect(dirIdx).toBeGreaterThanOrEqual(0);
      expect(a[dirIdx + 1]).toBe(deny);
      expect(a[dirIdx + 2]).toBe('--perms');
      expect(a[dirIdx + 3]).toBe('000');
      expect(a[dirIdx + 4]).toBe('--tmpfs');
      expect(a[dirIdx + 5]).toBe(deny);
    }
  });

  test('readDeny overlays appear AFTER /run tmpfs (last-wins mount ordering)', () => {
    const a = args({ readDenyRoots: ['/home/user/.ssh'] });
    const runIdx = a.indexOf('/run');
    const sshIdx = a.lastIndexOf('/home/user/.ssh');
    expect(sshIdx).toBeGreaterThan(runIdx);
  });

  test('no readDenyRoots → no --dir/--perms 000 entries', () => {
    const a = args({ readDenyRoots: [] });
    expect(a).not.toContain('--dir');
    const permIdx = a.indexOf('000');
    expect(permIdx).toBe(-1);
  });
});
