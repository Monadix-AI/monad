// Pure arg-generation tests — run on any platform (no kernel required).

import { expect, test } from 'bun:test';

import { buildBwrapArgs } from '../../../../../packages/atoms/src/sandbox/bwrap.ts';

const isLinux = process.platform === 'linux';

test('always includes namespace unshare and safety flags', () => {
  const args = buildBwrapArgs({ writableRoots: ['/sandbox'], net: 'unrestricted' });
  expect(args).toContain('--unshare-user');
  expect(args).toContain('--unshare-ipc');
  expect(args).toContain('--unshare-uts');
  expect(args).toContain('--unshare-pid');
  expect(args).toContain('--new-session');
  expect(args).toContain('--die-with-parent');
});

test('net:none adds --unshare-net', () => {
  const args = buildBwrapArgs({ writableRoots: ['/sandbox'], net: 'none' });
  expect(args).toContain('--unshare-net');
});

test('net:unrestricted omits --unshare-net', () => {
  const args = buildBwrapArgs({ writableRoots: ['/sandbox'], net: 'unrestricted' });
  expect(args).not.toContain('--unshare-net');
});

test('net:{ allowProxyPort } adds --unshare-net (bwrap cannot enforce proxy-only at kernel level)', () => {
  const args = buildBwrapArgs({ writableRoots: ['/sandbox'], net: { allowProxyPort: 9000 } });
  expect(args).toContain('--unshare-net');
});

test('writable roots get --bind entries', () => {
  const args = buildBwrapArgs({ writableRoots: ['/work', '/tmp'], net: 'unrestricted' });
  const bindPairs = args.flatMap((a, i) => (a === '--bind' ? [[args[i + 1], args[i + 2]]] : []));
  expect(bindPairs).toContainEqual(['/work', '/work']);
  expect(bindPairs).toContainEqual(['/tmp', '/tmp']);
});

test('readable roots get --ro-bind entries', () => {
  const args = buildBwrapArgs({
    writableRoots: ['/work'],
    readableRoots: ['/nix/store'],
    net: 'unrestricted'
  });
  const roPairs = args.flatMap((a, i) => (a === '--ro-bind' ? [[args[i + 1], args[i + 2]]] : []));
  expect(roPairs).toContainEqual(['/nix/store', '/nix/store']);
});

test('readable roots do not appear in writable --bind list', () => {
  const args = buildBwrapArgs({
    writableRoots: ['/work'],
    readableRoots: ['/nix/store'],
    net: 'unrestricted'
  });
  const bindPairs = args.flatMap((a, i) => (a === '--bind' ? [[args[i + 1], args[i + 2]]] : []));
  expect(bindPairs).not.toContainEqual(['/nix/store', '/nix/store']);
});

test('writableRoots undefined uses --bind / / (unrestricted write mode)', () => {
  const args = buildBwrapArgs({ writableRoots: undefined, net: 'unrestricted' });
  const bindPairs = args.flatMap((a, i) => (a === '--bind' ? [[args[i + 1], args[i + 2]]] : []));
  expect(bindPairs).toContainEqual(['/', '/']);
});

test('special filesystems are always overlaid', () => {
  const args = buildBwrapArgs({ writableRoots: ['/work'], net: 'unrestricted' });
  expect(args).toContain('--dev');
  expect(args).toContain('--proc');
  expect(args).toContain('--tmpfs');
  const devIdx = args.indexOf('--dev');
  expect(args[devIdx + 1]).toBe('/dev');
  const procIdx = args.indexOf('--proc');
  expect(args[procIdx + 1]).toBe('/proc');
  const tmpfsIdx = args.indexOf('--tmpfs');
  expect(args[tmpfsIdx + 1]).toBe('/run');
});

test('special filesystems are overlaid after the writable root bind (order matters)', () => {
  const args = buildBwrapArgs({ writableRoots: ['/work'], net: 'unrestricted' });
  const lastBind = args.lastIndexOf('--bind');
  const devIdx = args.indexOf('--dev');
  expect(devIdx).toBeGreaterThan(lastBind);
});

test('bwrapLauncher kind is bwrap', async () => {
  const { bwrapLauncher } = await import('../../../../../packages/atoms/src/sandbox/bwrap.ts');
  expect(bwrapLauncher.kind).toBe('bwrap');
});

test.skipIf(!isLinux)('bwrapLauncher.wrap prepends bwrap binary and appends -- before argv', async () => {
  const { bwrapLauncher } = await import('../../../../../packages/atoms/src/sandbox/bwrap.ts');
  const result = bwrapLauncher.wrap?.(['echo', 'hi'], { writableRoots: ['/work'], net: 'none' }) ?? [];
  // First element is the bwrap binary path
  expect(result[0]).toMatch(/bwrap/);
  // '--' separator before the actual command
  const sep = result.indexOf('--');
  expect(sep).toBeGreaterThan(0);
  expect(result.slice(sep + 1)).toEqual(['echo', 'hi']);
});
