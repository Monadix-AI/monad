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
  /** virtio-fs mountTag (w0, r0, …) passed to vfkit. */
  tag: string;
  /** Absolute guest path to mount it at (same as the host path so argv paths resolve unchanged). */
  path: string;
  readOnly: boolean;
}

export interface IgnitionSpec {
  /** The guest vsock exec agent binary (Linux aarch64), base64-encoded for the Ignition storage file. */
  agentBinaryB64: string;
  mounts: MountSpec[];
  egress: GuestEgressRules;
  /** Guest env exported into the workload (proxy vars under filtered net). */
  env?: Record<string, string>;
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
    ...spec.mounts.map(mountUnit)
  ];

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
