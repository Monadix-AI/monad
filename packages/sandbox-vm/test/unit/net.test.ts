import { expect, test } from 'bun:test';

import {
  GVPROXY_GATEWAY_IP,
  GVPROXY_GUEST_IP,
  GVPROXY_HOST_IP,
  guestNftables,
  guestProxyEnv,
  gvproxyArgv
} from '../../src/net/gvproxy.ts';

test('gvproxy argv wires the vfkit datagram socket and forwards ssh to the GUEST (not the gateway)', () => {
  const argv = gvproxyArgv({ gvproxyBin: '/bin/gvproxy', vfkitNetSock: '/t/net.sock', sshForwardSock: '/t/ssh.sock' });
  const j = argv.join(' ');
  expect(j).toContain('-listen-vfkit unixgram:///t/net.sock');
  expect(j).toContain('-forward-sock /t/ssh.sock');
  // forward-dst must be the guest DHCP address .2 — forwarding to the gateway .1 (gvproxy itself)
  // reaches a host with no sshd, so nothing ever runs in the VM.
  expect(GVPROXY_GUEST_IP).toBe('192.168.127.2');
  expect(j).toContain(`-forward-dst ${GVPROXY_GUEST_IP}:22`);
  expect(j).not.toContain(`-forward-dst ${GVPROXY_GATEWAY_IP}:`);
  expect(j).toContain('-forward-user monad');
});

test('net:none nftables permits control replies but blocks new egress', () => {
  const rules = guestNftables({ mode: 'none' });
  expect(rules).toContain('policy drop;');
  expect(rules).toContain('oif "lo" accept');
  expect(rules).toContain('ct state established,related accept');
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
