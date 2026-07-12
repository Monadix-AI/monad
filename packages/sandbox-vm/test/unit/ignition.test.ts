import { expect, test } from 'bun:test';

import { buildIgnition, systemdEscapePath } from '../../src/ignition.ts';

test('systemdEscapePath escapes hyphens the way systemd does (name must round-trip to Where=)', () => {
  // A literal hyphen in the path must become \x2d, NOT collide with the / → - separator.
  expect(systemdEscapePath('/Users/zeke/my-project')).toBe('Users-zeke-my\\x2dproject');
  expect(systemdEscapePath('/Users/x/ws')).toBe('Users-x-ws');
  // Dots are kept mid-path; a leading dot (after stripping /) is escaped.
  expect(systemdEscapePath('/var/lib/foo.bar')).toBe('var-lib-foo.bar');
});

type IgnFile = { path: string; contents?: { source: string } };

test('the monad guest user has NO wheel group (no passwordless sudo → cannot disable the firewall)', () => {
  const cfg = buildIgnition({ agentBinaryB64: 'QQ==', mounts: [], egress: { mode: 'none' } });
  const user = cfg.passwd.users[0];
  expect(user?.name).toBe('monad');
  expect(user?.groups).toBeUndefined();
});

test('the exec agent unit is gated on the firewall (workload never runs before egress rules apply)', () => {
  const cfg = buildIgnition({ agentBinaryB64: 'QQ==', mounts: [], egress: { mode: 'filtered', proxyPort: 8080 } });
  const fw = cfg.systemd.units.find((u) => u.name === 'monad-firewall.service');
  expect(fw?.contents).toContain('Before=network-pre.target network.target monad-vsock-agent.service');
  const agent = cfg.systemd.units.find((u) => u.name === 'monad-vsock-agent.service');
  expect(agent?.contents).toContain('Requires=monad-firewall.service');
  expect(agent?.contents).toContain('ExecStart=/usr/local/bin/monad-vsock-agent');
});

function decodeDataUri(uri: string): string {
  const b64 = uri.replace(/^data:;base64,/, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

test('ignition creates the unprivileged monad user and injects the vsock agent binary', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QUJD',
    mounts: [],
    egress: { mode: 'unrestricted' }
  });
  expect(cfg.ignition.version).toBe('3.4.0');
  const user = cfg.passwd.users[0];
  expect(user?.name).toBe('monad');
  expect(user?.groups).toBeUndefined(); // no wheel → no sudo
  const agent = cfg.storage.files.find((f) => (f as IgnFile).path === '/usr/local/bin/monad-vsock-agent') as
    | (IgnFile & { mode?: number })
    | undefined;
  expect(agent?.contents?.source).toBe('data:;base64,QUJD');
  expect(agent?.mode).toBe(0o755);
});

test('the firewall file carries the egress nftables ruleset', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    mounts: [],
    egress: { mode: 'filtered', proxyPort: 8080 }
  });
  const nft = cfg.storage.files.find((f) => (f as IgnFile).path === '/etc/monad/nftables.conf') as IgnFile | undefined;
  expect(nft).toBeDefined();
  const rules = decodeDataUri(nft?.contents?.source ?? '');
  expect(rules).toContain('policy drop;');
  expect(rules).toContain('dport 8080 accept');
});

test('each mount becomes a virtiofs .mount unit ordered before the firewall', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    mounts: [{ tag: 'w0', path: '/Users/x/ws', readOnly: false }],
    egress: { mode: 'none' }
  });
  const unit = cfg.systemd.units.find((u) => u.name === 'Users-x-ws.mount');
  expect(unit?.contents).toContain('What=w0');
  expect(unit?.contents).toContain('Where=/Users/x/ws');
  expect(unit?.contents).toContain('Type=virtiofs');
  expect(unit?.contents).toContain('Options=rw,nofail');
});
