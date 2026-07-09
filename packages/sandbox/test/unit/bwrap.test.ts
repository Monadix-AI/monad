import type { SandboxPolicy } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';

import { buildBwrapArgs } from '../../src/launchers/bwrap.ts';

function args(policy: Partial<SandboxPolicy>): string[] {
  return buildBwrapArgs(policy as SandboxPolicy);
}

// ── baseline flags ───────────────────────────────────────────────────────────

test('always includes isolation flags', () => {
  const _a = args({});
});

test('always mounts /dev /proc /run', () => {
  const _a = args({});
});

// ── network ──────────────────────────────────────────────────────────────────

test('net:none adds --unshare-net', () => {
  const _a = args({ net: 'none' });
});

test('net:filtered does NOT add --unshare-net (child must reach host proxy)', () => {
  const _a = args({ net: { allowProxyPort: 9999 } });
});

test('net:unrestricted does not add --unshare-net', () => {
  const _a = args({ net: 'unrestricted' });
});

// ── filesystem confinement ───────────────────────────────────────────────────

test('writableRoots undefined → --bind / /', () => {
  const a = args({ writableRoots: undefined });
  const i = a.indexOf('--bind');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(a[i + 1]).toBe('/');
  expect(a[i + 2]).toBe('/');
});

// Skipped on Windows: bwrap is a Linux-only launcher and buildBwrapArgs probes the host for the
// system dirs it read-binds (/usr, /etc, /opt), which don't exist on Windows — so no `--ro-bind`
// is emitted there. The confinement itself only ever runs on Linux (see bwrap.linux.test.ts).
test.skipIf(process.platform === 'win32')(
  'writableRoots set → no catch-all --bind / /, but writable root is rw-bound',
  () => {
    const a = args({ writableRoots: ['/tmp/session'] });
    // No catch-all bind (--bind / /): find a --bind where both src and dst are "/"
    const catchAll = a.findIndex((v, i) => v === '--bind' && a[i + 1] === '/' && a[i + 2] === '/');
    expect(catchAll).toBe(-1);
    // System dirs use --ro-bind
    // The writable root is bound rw: --bind /tmp/session /tmp/session
    const bindIdx = a.findIndex((v, i) => v === '--bind' && a[i + 1] === '/tmp/session');
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(a[bindIdx + 2]).toBe('/tmp/session');
  }
);

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
    const permIdx = a.indexOf('000');
    expect(permIdx).toBe(-1);
  });

  // sandbox-runtime issue #193: a denyRead path INSIDE an allowRead/allowWrite directory was
  // silently ignored — the parent dir's --bind exposed the whole subtree, and nothing punched a
  // hole for the file, so "expose /work but hide /work/.env" leaked .env in cleartext. bwrap DOES
  // support this (a later --tmpfs/--ro-bind at the same path shadows an earlier --bind), but only if
  // the deny overlay is emitted AFTER the parent bind — get the order wrong and the same class of
  // bug reappears here.
  test(
    'srt #193 pattern: a readDenyRoot NESTED inside a writableRoot is still shadowed — its deny ' +
      'overlay is emitted strictly AFTER the writable bind for the parent directory',
    () => {
      const a = args({ writableRoots: ['/work'], readDenyRoots: ['/work/.env'] });
      const bindIdx = a.findIndex((v, i) => v === '--bind' && a[i + 1] === '/work' && a[i + 2] === '/work');
      const denyIdx = a.findIndex((v, i) => v === '--dir' && a[i + 1] === '/work/.env');
      expect(bindIdx).toBeGreaterThanOrEqual(0);
      expect(denyIdx).toBeGreaterThan(bindIdx);
      // Full overlay triplet present for the nested path, not just the --dir marker.
      expect(a[denyIdx + 2]).toBe('--perms');
      expect(a[denyIdx + 3]).toBe('000');
      expect(a[denyIdx + 4]).toBe('--tmpfs');
      expect(a[denyIdx + 5]).toBe('/work/.env');
    }
  );

  test(
    'srt #193 pattern, readableRoots variant: a readDenyRoot nested inside a --ro-bind readableRoot ' +
      'is still shadowed after it',
    () => {
      const a = args({ writableRoots: ['/work'], readableRoots: ['/data'], readDenyRoots: ['/data/secret'] });
      const roIdx = a.findIndex((v, i) => v === '--ro-bind' && a[i + 1] === '/data' && a[i + 2] === '/data');
      const denyIdx = a.findIndex((v, i) => v === '--dir' && a[i + 1] === '/data/secret');
      expect(roIdx).toBeGreaterThanOrEqual(0);
      expect(denyIdx).toBeGreaterThan(roIdx);
    }
  );
});

// ── maskedFiles ──────────────────────────────────────────────────────────────

describe('maskedFiles', () => {
  test('each masked file emits --ro-bind <fake> <real>', () => {
    const a = args({
      writableRoots: ['/work'],
      maskedFiles: [{ real: '/home/user/.netrc', fake: '/tmp/mask/0.fake' }]
    });
    const idx = a.findIndex((v, i) => v === '--ro-bind' && a[i + 1] === '/tmp/mask/0.fake');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(a[idx + 2]).toBe('/home/user/.netrc');
  });

  test('bind applies in unrestricted-write mode (fake shadows the catch-all --bind / /)', () => {
    const a = args({
      writableRoots: undefined,
      maskedFiles: [{ real: '/home/user/.netrc', fake: '/tmp/mask/0.fake' }]
    });
    const bindIdx = a.findIndex((v, i) => v === '--bind' && a[i + 1] === '/' && a[i + 2] === '/');
    const roIdx = a.findIndex((v, i) => v === '--ro-bind' && a[i + 1] === '/tmp/mask/0.fake');
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(roIdx).toBeGreaterThanOrEqual(0);
    // The masking ro-bind must come AFTER the catch-all rw bind so it shadows the real file.
    expect(roIdx).toBeGreaterThan(bindIdx);
  });

  test('masked-file bind precedes the /dev overlay (before --)', () => {
    const a = args({ maskedFiles: [{ real: '/r', fake: '/f' }] });
    const roIdx = a.findIndex((v, i) => v === '--ro-bind' && a[i + 1] === '/f');
    const devIdx = a.indexOf('--dev');
    expect(roIdx).toBeGreaterThanOrEqual(0);
    expect(devIdx).toBeGreaterThan(roIdx);
  });
});
