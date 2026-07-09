// Attack-pattern tests for the call-time SSRF/path-traversal primitives (security.ts). These are
// modeled on real bypass techniques (SSRF IP-obfuscation, hostname-normalization confusion, symlink/
// prefix path-escape) rather than exhaustive input/output unit coverage — each test is "can an
// attacker get past this guard", not "does this function return X for Y".

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertPathWithinRoots, assertUrlAllowed, isBlockedIp, ToolSecurityError } from '../../src/security.ts';

describe('SSRF: isBlockedIp / assertUrlAllowed — cloud-metadata and loopback obfuscation', () => {
  test('IPv4-mapped IPv6 literal reaching cloud metadata (::ffff:169.254.169.254) is blocked', () => {
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
    expect(() => assertUrlAllowed('http://[::ffff:169.254.169.254]/latest/meta-data/')).toThrow(ToolSecurityError);
  });

  test('IPv4-mapped IPv6 literal reaching loopback (::ffff:127.0.0.1) is blocked', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
  });

  test('bare cloud-metadata IP (169.254.169.254) is blocked outright, not just link-local generally', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
  });

  test('trailing FQDN dot does not dodge the localhost blocklist ("localhost." === "localhost")', () => {
    expect(() => assertUrlAllowed('http://localhost./')).toThrow(ToolSecurityError);
  });

  test('mixed-case hostname does not dodge the localhost blocklist ("LOCALHOST")', () => {
    expect(() => assertUrlAllowed('http://LOCALHOST/')).toThrow(ToolSecurityError);
  });

  test('bracketed IPv6 loopback literal ([::1]) is blocked, brackets do not hide the address', () => {
    expect(() => assertUrlAllowed('http://[::1]/')).toThrow(ToolSecurityError);
  });

  test('a *.local mDNS-style host is blocked (commonly resolves to a LAN-internal device)', () => {
    expect(() => assertUrlAllowed('http://nas.local/')).toThrow(ToolSecurityError);
  });

  test('scheme smuggling: file:// and gopher:// are rejected, only http(s) is ever dialed', () => {
    expect(() => assertUrlAllowed('file:///etc/passwd')).toThrow(ToolSecurityError);
    expect(() => assertUrlAllowed('gopher://169.254.169.254/')).toThrow(ToolSecurityError);
  });

  test(
    'documents the trust boundary: a public hostname is NOT resolved here, so a name that later ' +
      'resolves to a private IP (DNS rebinding) passes assertUrlAllowed — callers MUST re-check the ' +
      'resolved address with isBlockedIp after DNS (egress-proxy.ts defaultAssertDialable does this)',
    () => {
      const url = assertUrlAllowed('http://rebind.example.com/');
      expect(url.hostname).toBe('rebind.example.com');
      // The guard alone cannot catch this — that is the documented contract, verified here so a
      // future edit that silently narrows the contract (e.g. adding DNS resolution here) is visible.
    }
  );
});

describe('path traversal: assertPathWithinRoots — sandbox-escape attempts', () => {
  const root = '/workspace/session-abc';

  test('lexical ../ traversal out of the sandbox root is rejected', () => {
    expect(() => assertPathWithinRoots('../../../etc/passwd', [root])).toThrow(ToolSecurityError);
  });

  test(
    'sibling-prefix confusion: a root-adjacent directory that merely starts with the same string ' +
      '("/workspace/session-abc-evil") must NOT be treated as inside the root — a naive `startsWith` ' +
      'check (without the separator) would let this through',
    () => {
      expect(() => assertPathWithinRoots('/workspace/session-abc-evil/secret', [root])).toThrow(ToolSecurityError);
    }
  );

  test('an absolute path entirely outside every root is rejected even with no traversal syntax', () => {
    expect(() => assertPathWithinRoots('/etc/passwd', [root])).toThrow(ToolSecurityError);
  });

  test('a relative path that resolves (via ../) past the root is rejected', () => {
    expect(() => assertPathWithinRoots('foo/../../bar', [root])).toThrow(ToolSecurityError);
  });

  test('the root itself and a same-prefix subpath are both allowed (sanity: guard is not overbroad)', () => {
    expect(assertPathWithinRoots(root, [root])).toBe(resolve(root));
    expect(assertPathWithinRoots('sub/file.txt', [root])).toBe(resolve(root, 'sub/file.txt'));
  });

  test('empty path is rejected rather than silently resolving to the root/cwd', () => {
    expect(() => assertPathWithinRoots('', [root])).toThrow(ToolSecurityError);
  });
});

describe('path traversal: symlink escape — documents the caller obligation', () => {
  test(
    'a symlink INSIDE the sandbox root that points OUTSIDE it lexically resolves as "within" the ' +
      'root (assertPathWithinRoots never touches the filesystem) — callers that open an EXISTING ' +
      'file must realpath() the result and re-check, or a planted symlink escapes the sandbox',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'monad-sec-test-'));
      const sandboxRoot = join(base, 'sandbox');
      const outside = join(base, 'outside');
      try {
        require('node:fs').mkdirSync(sandboxRoot);
        require('node:fs').mkdirSync(outside);
        writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
        symlinkSync(join(outside, 'secret.txt'), join(sandboxRoot, 'link'));

        // Lexical check alone passes — this is the documented gap, not a bug.
        const resolved = assertPathWithinRoots('link', [sandboxRoot]);
        expect(resolved).toBe(join(sandboxRoot, 'link'));

        // The escape is only caught by realpath()-ing the resolved path and re-checking it against
        // the root — exactly as fs.ts is documented to do. Assert that omission here would leak.
        const real = require('node:fs').realpathSync(resolved);
        const realSandboxRoot = require('node:fs').realpathSync(sandboxRoot);
        const realOutsideFile = require('node:fs').realpathSync(join(outside, 'secret.txt'));
        expect(real.startsWith(realSandboxRoot)).toBe(false);
        expect(real).toBe(realOutsideFile);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  );
});
