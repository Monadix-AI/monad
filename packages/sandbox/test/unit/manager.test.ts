import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
  expect(m.sandboxPolicy.writableRoots).toContain(tmpdir());
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

test('tlsTerminate injects CA-trust env', () => {
  const m = mgr({
    platform: 'darwin',
    net: 'filtered',
    tlsTerminate: true,
    allowedDomains: ['example.com']
  });
  const env = m.childEnv;
  expect(readFileSync(env.NODE_EXTRA_CA_CERTS ?? '', 'utf8')).toStartWith('-----BEGIN CERTIFICATE-----');
});

test('dispose is idempotent', () => {
  const m = new SandboxManager({ platform: 'darwin', net: 'filtered' });
  m.dispose();
  expect(() => m.dispose()).not.toThrow();
});
