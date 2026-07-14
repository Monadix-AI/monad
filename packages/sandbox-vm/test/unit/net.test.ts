import { expect, test } from 'bun:test';

import {
  GVPROXY_GATEWAY_IP,
  GVPROXY_HOST_IP,
  guestNftables,
  guestProxyEnv,
  gvproxyArgv
} from '../../src/net/gvproxy.ts';

test('gvproxy argv: vfkit transport uses -listen-vfkit unixgram (macOS)', () => {
  const argv = gvproxyArgv({ gvproxyBin: '/bin/gvproxy', netSock: '/t/net.sock', transport: 'vfkit' });
  const j = argv.join(' ');
  expect(j).toContain('-listen-vfkit unixgram:///t/net.sock');
  // gvproxy's DEFAULT is a host-loopback ssh forward on 2222 — it must be disabled or two VMs'
  // gvproxies collide on the port (exec is vsock; nothing uses ssh).
  expect(j).toContain('-ssh-port -1');
});

test('gvproxy argv: qemu transport uses -listen-qemu unix (Linux)', () => {
  const argv = gvproxyArgv({ gvproxyBin: '/bin/gvproxy', netSock: '/t/net.sock', transport: 'qemu' });
  const j = argv.join(' ');
  expect(j).toContain('-listen-qemu unix:///t/net.sock');
  expect(j).not.toContain('-listen-vfkit');
});

test('gvproxy argv: hyperv transport serves the /connect tunnel on a plain unix listener (Windows)', () => {
  const argv = gvproxyArgv({ gvproxyBin: '/bin/gvproxy', netSock: '/t/net.sock', transport: 'hyperv' });
  const j = argv.join(' ');
  expect(j).toContain('-listen unix:///t/net.sock');
  expect(j).not.toContain('-listen-qemu');
  expect(j).not.toContain('-listen-vfkit');
  expect(j).toContain('-ssh-port -1');
});

test('net:none nftables drops everything but loopback', () => {
  const rules = guestNftables({ mode: 'none' });
  expect(rules).toContain('policy drop;');
  expect(rules).toContain('oif "lo" accept');
  expect(rules).not.toContain('dport 53');
});

test('net:filtered nftables allows only DNS + host proxy, drops the rest', () => {
  const rules = guestNftables({ mode: 'filtered', proxyPort: 8080 });
  expect(rules).toContain('policy drop;');
  expect(rules).toContain(`ip daddr ${GVPROXY_GATEWAY_IP} udp dport 53 accept`);
  expect(rules).toContain(`ip daddr ${GVPROXY_HOST_IP} tcp dport 8080 accept`);
});

test('net:filtered without a proxy port is a hard error (no silent open)', () => {
  expect(() => guestNftables({ mode: 'filtered' })).toThrow();
});

test('net:unrestricted installs no rules', () => {
  expect(guestNftables({ mode: 'unrestricted' })).not.toContain('policy drop');
});

test('proxy env points at the gvproxy host IP', () => {
  const env = guestProxyEnv(8080);
  expect(env.HTTP_PROXY).toBe(`http://${GVPROXY_HOST_IP}:8080`);
  expect(env.HTTPS_PROXY).toBe(`http://${GVPROXY_HOST_IP}:8080`);
});
