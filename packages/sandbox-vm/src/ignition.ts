// The guest boot config. Fedora CoreOS boots from an Ignition config (not cloud-init); vfkit passes
// it via `--ignition`. We author the Ignition JSON (spec 3.4) directly — no butane needed — to:
//   • create the unprivileged `monad` user (its home);
//   • install monad-vsock-agent (the exec channel) + a systemd unit that runs it;
//   • drop the nftables ruleset that enforces the egress mode (the real `net:'filtered'` boundary);
//   • mount each policy root's virtio-fs tag at its host path inside the guest.
//
// The exec channel is vsock (NIC-independent), so net:'none' runs with NO network device at all — the
// agent still reaches the guest. The agent runs the workload as the unprivileged `monad` user, so it
// cannot alter the firewall or mounts installed here.

import { type GuestEgressRules, guestNftables } from './net/gvproxy.ts';

export interface MountSpec {
  /** virtio-fs mountTag (w0, r0, …) passed to vfkit, or the 9p share label on Windows. */
  tag: string;
  /** Absolute HOST path of the shared directory. On macOS/Linux it doubles as the guest mount point
   *  (so argv paths resolve unchanged); on Windows the guest point is `guestPath`. */
  path: string;
  /** Windows: the translated guest mount point (/mnt/<drive>/…). Unset on macOS/Linux. */
  guestPath?: string;
  /** Windows: host vsock port of this share's 9p server (exec=1024, net=1025, 9p from 1026). */
  vsockPort?: number;
  readOnly: boolean;
}

export interface IgnitionSpec {
  /** The guest vsock exec agent binary (Linux aarch64), base64-encoded for the Ignition storage file. */
  agentBinaryB64: string;
  mounts: MountSpec[];
  egress: GuestEgressRules;
  /** Guest env exported into the workload (proxy vars under filtered net). */
  env?: Record<string, string>;
  /** Windows/Hyper-V only: mount over 9p-vsock units instead of virtio-fs mount units. */
  mountTransport?: 'virtiofs' | '9p-vsock';
  /** Windows/Hyper-V, net≠none: the gvforwarder binary (tap⇄vsock network forwarder) + the vsock
   *  port its tunnel dials — the guest NIC is a tap into the host's gvproxy, not a real NIC. */
  gvforwarderB64?: string;
  netVsockPort?: number;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function dataUri(content: string): string {
  return `data:;base64,${b64(content)}`;
}

/** Escape an absolute path into a systemd mount-unit name the way `systemd-escape --path` does:
 *  strip leading/trailing slashes, `/`→`-`, keep [A-Za-z0-9_.], escape everything else (including a
 *  literal `-`, and a leading `.`) as `\xNN`. A naive `/`→`-` replace breaks on any hyphen in the
 *  path (systemd derives the expected name from Where= and refuses to load on a mismatch). */
export function systemdEscapePath(path: string): string {
  const p = path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (p === '') return '-';
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === '/') {
      out += '-';
    } else if (/[A-Za-z0-9_.]/.test(c) && !(i === 0 && c === '.')) {
      out += c;
    } else {
      out += `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }
  }
  return out;
}

/** systemd mount unit for one virtio-fs tag. CoreOS mounts virtiofs by tag with the `virtiofs` fstype. */
function mountUnit(m: MountSpec): { name: string; enabled: boolean; contents: string } {
  const unitName = `${systemdEscapePath(m.path)}.mount`;
  const opts = m.readOnly ? 'ro,nofail' : 'rw,nofail';
  return {
    name: unitName,
    enabled: true,
    contents: [
      '[Unit]',
      `Description=monad virtio-fs mount ${m.tag}`,
      'DefaultDependencies=no',
      'After=systemd-remount-fs.service',
      'Before=local-fs.target monad-firewall.service',
      '[Mount]',
      `What=${m.tag}`,
      `Where=${m.path}`,
      'Type=virtiofs',
      `Options=${opts}`,
      '[Install]',
      'WantedBy=local-fs.target',
      ''
    ].join('\n')
  };
}

/** Windows/Hyper-V: a oneshot unit that mounts one 9p-over-vsock share (winvm-helper's serve9p on
 *  the host side) via the agent binary's mount9p mode. Ordered like the virtio-fs mount units:
 *  before the firewall, which is before the exec agent — a workload never sees a half-mounted VM. */
function mount9pUnit(m: MountSpec): { name: string; enabled: boolean; contents: string } {
  if (m.vsockPort === undefined || m.guestPath === undefined) {
    throw new Error(`ignition: 9p mount ${m.tag} needs vsockPort + guestPath`);
  }
  const ro = m.readOnly ? ' -ro' : '';
  return {
    name: `monad-9p-${m.tag}.service`,
    enabled: true,
    contents: [
      '[Unit]',
      `Description=monad 9p mount ${m.tag}`,
      'DefaultDependencies=no',
      'After=systemd-remount-fs.service',
      'Before=local-fs.target monad-firewall.service',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      // The guest path is double-quoted: systemd splits ExecStart on whitespace, so an unquoted path
      // with a space (e.g. C:\Users\First Last → /mnt/c/Users/First Last) would truncate -target AND
      // push -ro past a positional token (Go's flag parser stops at the first non-flag), silently
      // mounting a read-only root read-write. Windows filenames can't contain '"', so quoting is safe.
      `ExecStart=/usr/local/bin/monad-vsock-agent mount9p${ro} -port ${m.vsockPort} -target "${m.guestPath}"`,
      '[Install]',
      'WantedBy=local-fs.target',
      ''
    ].join('\n')
  };
}

// Windows/Hyper-V guest networking: the VM has NO real NIC — gvforwarder bridges a tap device to
// the host's gvproxy over vsock (podman machine's hyperv shape). NetworkManager pre-creates the tap
// from a keyfile (hence -preexisting) and DHCPs on it; gvproxy's static lease pins the guest to
// 192.168.127.2 by this well-known MAC.
const GVFORWARDER_MAC = '5A:94:EF:E4:0C:EE';

function vsockNetKeyfile(): string {
  return [
    '[connection]',
    'id=vsock0',
    'type=tun',
    'interface-name=vsock0',
    '',
    '[tun]',
    'mode=2',
    '',
    '[802-3-ethernet]',
    `cloned-mac-address=${GVFORWARDER_MAC}`,
    '',
    '[ipv4]',
    'method=auto',
    ''
  ].join('\n');
}

function vsockNetUnit(netVsockPort: number): { name: string; enabled: boolean; contents: string } {
  return {
    name: 'monad-vsock-network.service',
    enabled: true,
    contents: [
      '[Unit]',
      'Description=monad vsock guest network (gvforwarder tap to host gvproxy)',
      'After=NetworkManager.service',
      '[Service]',
      `ExecStart=/usr/local/bin/monad-gvforwarder -preexisting -iface vsock0 -url vsock://2:${netVsockPort}/connect`,
      'ExecStartPost=/usr/bin/nmcli c up vsock0',
      'Restart=always',
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n')
  };
}

/** The oneshot unit that applies the nftables egress ruleset. It is ordered before the exec agent, so
 *  the workload can never run before the firewall is in place; `Requires` makes the agent fail to
 *  start if nft errored (never run with egress open because the ruleset didn't apply). */
function firewallUnit(rulesPath: string): { name: string; enabled: boolean; contents: string } {
  return {
    name: 'monad-firewall.service',
    enabled: true,
    contents: [
      '[Unit]',
      'Description=monad guest egress firewall',
      'DefaultDependencies=no',
      'After=local-fs.target',
      'Before=network-pre.target network.target monad-vsock-agent.service',
      'Wants=network-pre.target',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      `ExecStart=/usr/sbin/nft -f ${rulesPath}`,
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n')
  };
}

/** The unit that runs the vsock exec agent — the guest's control plane. Root (to bind vsock + be the
 *  trusted broker), but it drops each workload to the unprivileged `monad` user. Gated on the firewall
 *  so a workload never runs before egress rules are applied. When there is a NIC (filtered/unrestricted)
 *  it also waits for `network-online.target` so a command can't race an incomplete DHCP lease; net:'none'
 *  has no NIC and must NOT wait (network-online never arrives). */
function agentUnit(hasNic: boolean): { name: string; enabled: boolean; contents: string } {
  const after = ['local-fs.target', 'monad-firewall.service'];
  const extra: string[] = [];
  if (hasNic) {
    after.push('network-online.target');
    extra.push('Wants=network-online.target');
  }
  return {
    name: 'monad-vsock-agent.service',
    enabled: true,
    contents: [
      '[Unit]',
      'Description=monad vsock exec agent',
      `After=${after.join(' ')}`,
      'Requires=monad-firewall.service',
      ...extra,
      '[Service]',
      'ExecStart=/usr/local/bin/monad-vsock-agent',
      'Restart=always',
      '[Install]',
      'WantedBy=multi-user.target',
      ''
    ].join('\n')
  };
}

/** The subset of the Ignition config shape callers/tests read. Loose where Ignition is (files/units
 *  are heterogeneous), typed where we assert on it. */
export interface IgnitionConfig {
  ignition: { version: string };
  passwd: { users: { name: string; homeDir?: string; groups?: string[] }[] };
  storage: { files: object[]; directories: object[] };
  systemd: { units: { name: string; contents?: string; dropins?: { name: string; contents: string }[] }[] };
}

/** Build the full Ignition config object. */
export function buildIgnition(spec: IgnitionSpec): IgnitionConfig {
  const rulesPath = '/etc/monad/nftables.conf';
  const files: object[] = [
    {
      path: rulesPath,
      mode: 0o600,
      contents: { source: dataUri(guestNftables(spec.egress)) }
    },
    {
      // The vsock exec agent (Linux aarch64), injected as a base64 blob and marked executable.
      path: '/usr/local/bin/monad-vsock-agent',
      mode: 0o755,
      contents: { source: `data:;base64,${spec.agentBinaryB64}` }
    }
  ];

  if (spec.gvforwarderB64) {
    files.push({
      path: '/usr/local/bin/monad-gvforwarder',
      mode: 0o755,
      contents: { source: `data:;base64,${spec.gvforwarderB64}` }
    });
    files.push({
      // NetworkManager keyfiles are rejected unless root-owned 0600.
      path: '/etc/NetworkManager/system-connections/vsock0.nmconnection',
      mode: 0o600,
      contents: { source: dataUri(vsockNetKeyfile()) }
    });
  }

  if (spec.env && Object.keys(spec.env).length > 0) {
    const envLines = Object.entries(spec.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    files.push({
      path: '/etc/environment',
      mode: 0o644,
      append: [{ source: dataUri(`${envLines}\n`) }]
    });
  }

  const hasNic = spec.egress.mode !== 'none';
  const units: IgnitionConfig['systemd']['units'] = [
    firewallUnit(rulesPath),
    agentUnit(hasNic),
    ...spec.mounts.map(spec.mountTransport === '9p-vsock' ? mount9pUnit : mountUnit)
  ];
  if (spec.gvforwarderB64) {
    if (spec.netVsockPort === undefined) throw new Error('ignition: gvforwarder needs netVsockPort');
    units.push(vsockNetUnit(spec.netVsockPort));
  }

  return {
    ignition: { version: '3.4.0' },
    passwd: {
      users: [
        {
          // Unprivileged, NO `wheel` group: on Fedora CoreOS wheel grants passwordless sudo, which
          // would let a workload `sudo nft flush ruleset` and defeat every confinement guarantee.
          name: 'monad',
          homeDir: '/home/monad'
        }
      ]
    },
    storage: { files, directories: [{ path: '/etc/monad', mode: 0o755 }] },
    systemd: { units }
  };
}

export function serializeIgnition(spec: IgnitionSpec): string {
  return JSON.stringify(buildIgnition(spec));
}
