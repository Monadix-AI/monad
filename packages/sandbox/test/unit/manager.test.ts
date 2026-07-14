import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SandboxManager, SandboxUnavailableError } from '../../src/manager.ts';

const open: SandboxManager[] = [];
function mgr(opts: ConstructorParameters<typeof SandboxManager>[0]): SandboxManager {
  const m = new SandboxManager(opts);
  open.push(m);
  return m;
}
afterEach(() => {
  for (const m of open.splice(0)) m.dispose();
});

test('unconfined platform throws unless allowUnconfined', () => {
  // 'freebsd' matches no light launcher → noneLauncher.
  expect(() => mgr({ platform: 'freebsd' as NodeJS.Platform })).toThrow(SandboxUnavailableError);
  const m = mgr({ platform: 'freebsd' as NodeJS.Platform, allowUnconfined: true });
  expect(m.confined).toBe(false);
  // Unconfined: wrap returns raw argv.
  expect(m.wrap(['echo', 'hi'])).toEqual(['echo', 'hi']);
});

test('macOS auto-selects Seatbelt; net:unrestricted injects no env', () => {
  const m = mgr({ platform: 'darwin' });
  expect(m.confined).toBe(true);
  expect(m.launcher.kind).toBe('seatbelt');
  expect(m.childEnv).toEqual({});
  // policy: cwd + tmpdir writable, no maskedFiles.
  expect(m.sandboxPolicy.writableRoots).toContain(tmpdir());
  expect(m.sandboxPolicy.maskedFiles).toBeUndefined();
});

test('net:filtered stands up the proxy and injects proxy + SOCKS env', () => {
  const m = mgr({ platform: 'darwin', net: 'filtered', allowedDomains: ['example.com'] });
  const env = m.childEnv;
  expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(env.ALL_PROXY).toMatch(/^socks5h:\/\/127\.0\.0\.1:\d+$/);
  // Same muxed port for HTTP and SOCKS.
  const httpPort = (env.HTTPS_PROXY ?? '').split(':').at(-1);
  const socksPort = (env.ALL_PROXY ?? '').split(':').at(-1);
  expect(httpPort).toBe(socksPort);
  // Confined to the proxy port only.
  expect(m.sandboxPolicy.net).toEqual({ allowProxyPort: Number(httpPort) });
});

test('tlsTerminate injects CA-trust env; credentials give the child a sentinel not the real value', () => {
  const m = mgr({
    platform: 'darwin',
    net: 'filtered',
    tlsTerminate: true,
    allowedDomains: ['example.com'],
    credentials: [{ name: 'TOKEN', value: 'supersecret', injectHosts: ['example.com'] }]
  });
  const env = m.childEnv;
  expect(env.NODE_EXTRA_CA_CERTS).toBeTruthy();
  // The child's env var holds the sentinel, never the real secret.
  expect(env.TOKEN).toStartWith('fake_value_');
  expect(env.TOKEN).not.toBe('supersecret');
});

test('structured environment credentials remain parseable and omit failures without exposing input', () => {
  const messages: string[] = [];
  const mgr = new SandboxManager({
    platform: 'darwin',
    allowUnconfined: true,
    net: 'filtered',
    tlsTerminate: true,
    credentials: [
      {
        name: 'STRUCTURED',
        value: 'token=real-secret;scope=read',
        injectHosts: ['example.com'],
        transform: { extract: 'token=([^;]+)' }
      },
      {
        name: 'BROKEN',
        value: 'must-not-appear',
        injectHosts: ['example.com'],
        transform: { extract: 'no-match=(.+)' }
      }
    ],
    log: (message) => messages.push(message)
  });
  expect(mgr.childEnv.STRUCTURED).toStartWith('token=fake_value_');
  expect(mgr.childEnv.STRUCTURED).toEndWith(';scope=read');
  expect(mgr.childEnv.BROKEN).toBeUndefined();
  expect(messages.join('\n')).toContain('NO_MATCH');
  expect(messages.join('\n')).not.toContain('must-not-appear');
  mgr.dispose();
});

test('an unmaskable credential source becomes a read deny before launcher policy', () => {
  const credentialDirectory = mkdtempSync(join(tmpdir(), 'monad-manager-credential-dir-'));
  const m = mgr({
    platform: 'darwin',
    net: 'filtered',
    tlsTerminate: true,
    credentialFiles: [{ name: 'DIRECTORY', path: credentialDirectory, injectHosts: ['example.com'] }]
  });

  expect(m.sandboxPolicy.maskedFiles).toBeUndefined();
  expect(m.sandboxPolicy.readDenyRoots).toContain(realpathSync(credentialDirectory));
});

test('dispose is idempotent', () => {
  const m = new SandboxManager({ platform: 'darwin', net: 'filtered' });
  m.dispose();
  expect(() => m.dispose()).not.toThrow();
});
