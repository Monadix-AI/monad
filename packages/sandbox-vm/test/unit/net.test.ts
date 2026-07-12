import { expect, test } from 'bun:test';

import {
  GVPROXY_GATEWAY_IP,
  GVPROXY_HOST_IP,
  guestNftables,
  guestProxyEnv,
  gvproxyArgv
} from '../../src/net/gvproxy.ts';

test('gvproxy argv wires the vfkit datagram socket and opens the host ssh-forward port', () => {
  const argv = gvproxyArgv({ gvproxyBin: '/bin/gvproxy', vfkitNetSock: '/t/net.sock', sshHostPort: 52999 });
  const j = argv.join(' ');
  expect(j).toContain('-listen-vfkit unixgram:///t/net.sock');
  // gvproxy opens a host-loopback listener on this port that tunnels to the guest sshd (guest:22),
  // the way podman machine reaches its VM — the exec channel ssh's to 127.0.0.1:<port>.
  expect(j).toContain('-ssh-port 52999');
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
