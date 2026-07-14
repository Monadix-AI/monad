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

// ── Windows / Hyper-V variants ────────────────────────────────────────────────────────────────────

const WIN_MOUNT = {
  tag: 'w0',
  path: 'C:\\Users\\z\\proj',
  guestPath: '/mnt/c/Users/z/proj',
  vsockPort: 1026,
  readOnly: false
};

test('9p-vsock transport emits mount9p oneshot units ordered before the firewall', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    mounts: [WIN_MOUNT, { ...WIN_MOUNT, tag: 'r0', vsockPort: 1027, readOnly: true }],
    egress: { mode: 'none' },
    mountTransport: '9p-vsock'
  });
  const w0 = cfg.systemd.units.find((u) => u.name === 'monad-9p-w0.service');
  // guest path is double-quoted so a space in the path can't truncate -target or drop -ro
  expect(w0?.contents).toContain(
    'ExecStart=/usr/local/bin/monad-vsock-agent mount9p -port 1026 -target "/mnt/c/Users/z/proj"'
  );
  expect(w0?.contents).toContain('Before=local-fs.target monad-firewall.service');
  expect(w0?.contents).not.toContain(' -ro');
  const r0 = cfg.systemd.units.find((u) => u.name === 'monad-9p-r0.service');
  expect(r0?.contents).toContain('-port 1027');
  expect(r0?.contents).toContain('mount9p -ro -port 1027 -target "/mnt/c/Users/z/proj"');
  // no virtio-fs mount units on the 9p transport
  expect(cfg.systemd.units.some((u) => u.name.endsWith('.mount'))).toBe(false);
});

test('mount9p quotes the guest path so a space cannot truncate -target or drop -ro', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    mounts: [
      {
        tag: 'r0',
        path: 'C:\\Users\\First Last\\proj',
        guestPath: '/mnt/c/Users/First Last/proj',
        vsockPort: 1026,
        readOnly: true
      }
    ],
    egress: { mode: 'none' },
    mountTransport: '9p-vsock'
  });
  const unit = cfg.systemd.units.find((u) => u.name === 'monad-9p-r0.service');
  // -ro precedes the quoted path; the space stays inside the quotes so systemd keeps it one arg
  expect(unit?.contents).toContain('mount9p -ro -port 1026 -target "/mnt/c/Users/First Last/proj"');
});

test('a 9p mount without port/guestPath fails closed (never boot a VM missing a policy root)', () => {
  expect(() =>
    buildIgnition({
      agentBinaryB64: 'QQ==',
      mounts: [{ tag: 'w0', path: 'C:\\proj', readOnly: false }],
      egress: { mode: 'none' },
      mountTransport: '9p-vsock'
    })
  ).toThrow(/vsockPort/);
});

test('gvforwarder plane: binary + 0600 NM keyfile + tap unit dialing the net vsock port', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    mounts: [],
    egress: { mode: 'filtered', proxyPort: 8080 },
    mountTransport: '9p-vsock',
    gvforwarderB64: 'R1Y=',
    netVsockPort: 1025
  });
  const files = cfg.storage.files as IgnFile[];
  const fwd = files.find((f) => f.path === '/usr/local/bin/monad-gvforwarder');
  expect(fwd?.contents?.source).toBe('data:;base64,R1Y=');
  const keyfile = files.find((f) => f.path === '/etc/NetworkManager/system-connections/vsock0.nmconnection');
  expect((keyfile as { mode?: number })?.mode).toBe(0o600); // NM rejects world-readable keyfiles
  expect(decodeDataUri((keyfile as IgnFile).contents?.source ?? '')).toContain('interface-name=vsock0');
  const unit = cfg.systemd.units.find((u) => u.name === 'monad-vsock-network.service');
  expect(unit?.contents).toContain('-url vsock://2:1025/connect');
  expect(unit?.contents).toContain('ExecStartPost=/usr/bin/nmcli c up vsock0');
});

test('net:none on Windows has NO gvforwarder plane at all (vsock exec/9p need no NIC)', () => {
  const cfg = buildIgnition({
    agentBinaryB64: 'QQ==',
    mounts: [],
    egress: { mode: 'none' },
    mountTransport: '9p-vsock'
  });
  const files = cfg.storage.files as IgnFile[];
  expect(files.some((f) => f.path === '/usr/local/bin/monad-gvforwarder')).toBe(false);
  expect(cfg.systemd.units.some((u) => u.name === 'monad-vsock-network.service')).toBe(false);
});
