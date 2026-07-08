import { expect, test } from 'bun:test';
import { join, resolve, sep } from 'node:path';

import {
  assertPathWithinRoots,
  assertUrlAllowed,
  isBlockedIp,
  netFetchTool,
  ToolSecurityError
} from '#/capabilities/tools';

// ── isBlockedIp ───────────────────────────────────────────────────────────────

test('isBlockedIp: blocks loopback/private/link-local/metadata/unspecified', () => {
  for (const ip of [
    '127.0.0.1',
    '127.5.5.5',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    '::ffff:127.0.0.1' // IPv4-mapped loopback
  ]) {
    expect(isBlockedIp(ip)).toBe(true);
  }
});

test('isBlockedIp: allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111']) {
    expect(isBlockedIp(ip)).toBe(false);
  }
});

// ── assertUrlAllowed (SSRF) ─────────────────────────────────────────────────────

test('assertUrlAllowed: allows public http(s) URLs', () => {
  expect(assertUrlAllowed('https://example.com/path').hostname).toBe('example.com');
  expect(assertUrlAllowed('http://8.8.8.8:80/').hostname).toBe('8.8.8.8');
});

test('assertUrlAllowed: blocks non-http schemes', () => {
  for (const u of ['file:///etc/passwd', 'ftp://x/y', 'gopher://x', 'data:text/plain,hi']) {
    expect(() => assertUrlAllowed(u)).toThrow(ToolSecurityError);
  }
});

test('assertUrlAllowed: blocks loopback/private/metadata hosts', () => {
  for (const u of [
    'http://localhost/admin',
    'http://service.localhost/',
    'http://printer.local/',
    'http://127.0.0.1:52749/v1/sessions', // the daemon's own API
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://[::1]:52749/',
    'http://localhost./', // FQDN trailing-dot must not bypass the lexical blocklist
    'http://printer.local./'
  ]) {
    expect(() => assertUrlAllowed(u)).toThrow(ToolSecurityError);
  }
});

test('assertUrlAllowed: rejects malformed URLs', () => {
  expect(() => assertUrlAllowed('not a url')).toThrow(ToolSecurityError);
});

test('netFetchTool: SSRF guard rejects blocked hosts before any network call', async () => {
  // Blocked hosts (cloud metadata, loopback, bad scheme) → security error, no socket opened.
  await expect(netFetchTool.run({ url: 'http://169.254.169.254/' }, {} as never)).rejects.toThrow(ToolSecurityError);
  await expect(netFetchTool.run({ url: 'http://localhost/' }, {} as never)).rejects.toThrow(ToolSecurityError);
  await expect(netFetchTool.run({ url: 'file:///etc/passwd' }, {} as never)).rejects.toThrow(ToolSecurityError);
});

// ── assertPathWithinRoots ───────────────────────────────────────────────────────

test('assertPathWithinRoots: allows paths inside a root', () => {
  const root = resolve(join(sep, 'home', 'u', 'workspace'));
  expect(assertPathWithinRoots(join(root, 'notes.txt'), [root])).toBe(join(root, 'notes.txt'));
  expect(assertPathWithinRoots(root, [root])).toBe(root); // the root itself
  // Relative paths resolve against the primary root.
  expect(assertPathWithinRoots('sub/file.md', [root])).toBe(join(root, 'sub', 'file.md'));
});

test('assertPathWithinRoots: rejects .. traversal out of the sandbox', () => {
  const root = resolve(join(sep, 'home', 'u', 'workspace'));
  expect(() => assertPathWithinRoots(join(root, '..', '..', 'etc', 'passwd'), [root])).toThrow(ToolSecurityError);
  expect(() => assertPathWithinRoots(join(sep, 'etc', 'passwd'), [root])).toThrow(ToolSecurityError);
});

test('assertPathWithinRoots: a sibling prefix is not "inside" (boundary correctness)', () => {
  const root = resolve(join(sep, 'home', 'user'));
  // /home/user2 must NOT be treated as inside /home/user.
  expect(() => assertPathWithinRoots(join(sep, 'home', 'user2', 'x'), [root])).toThrow(ToolSecurityError);
});

test('assertPathWithinRoots: undefined roots = unrestricted', () => {
  const p = resolve(join(sep, 'etc', 'hosts'));
  expect(assertPathWithinRoots(p, undefined)).toBe(p);
});

test('assertPathWithinRoots: empty path is rejected', () => {
  expect(() => assertPathWithinRoots('', [join(sep, 'root')])).toThrow(ToolSecurityError);
});
