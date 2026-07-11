// The guest boot config. Fedora CoreOS boots from an Ignition config (not cloud-init); vfkit passes
// it via `--ignition`. We author the Ignition JSON (spec 3.4) directly — no butane needed — to:
//   • create the unprivileged `monad` user with the bundle's one-shot ssh pubkey;
//   • drop the nftables ruleset that enforces the egress mode (the real `net:'filtered'` boundary);
//   • mount each policy root's virtio-fs tag at its host path inside the guest;
//   • order sshd after the mounts + firewall are in place.
//
// The agent never gets root, so it cannot alter the firewall or mounts installed here.

import { type GuestEgressRules, guestNftables } from './net/gvproxy.ts';

export interface MountSpec {
  /** virtio-fs mountTag (w0, r0, …) passed to vfkit. */
  tag: string;
  /** Absolute guest path to mount it at (same as the host path so argv paths resolve unchanged). */
  path: string;
  readOnly: boolean;
}

export interface IgnitionSpec {
  sshPublicKey: string;
  mounts: MountSpec[];
  egress: GuestEgressRules;
  /** Guest env exported for the login shell (proxy vars under filtered net). */
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

/** The oneshot unit that applies the nftables ruleset before the agent can get a shell. Fedora CoreOS
 *  SOCKET-activates ssh (`sshd.socket` → per-connection `sshd@.service`), so ordering merely before
 *  `sshd.service` leaves a boot window where the agent connects with no firewall. We order before
 *  `sshd.socket` itself AND make the socket require this unit, so the listener never accepts a
 *  connection until nftables is loaded. Runs before the network comes up too. */
function firewallUnit(rulesPath: string): { name: string; enabled: boolean; contents: string } {
  return {
    name: 'monad-firewall.service',
    enabled: true,
    contents: [
      '[Unit]',
      'Description=monad guest egress firewall',
      'DefaultDependencies=no',
      'After=local-fs.target',
      'Before=sshd.socket sshd.service network-pre.target network.target',
      'Wants=network-pre.target',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      // Fail the unit (and thus block sshd.socket) if the ruleset can't be applied — never let the
      // agent in with egress open because nft errored.
      `ExecStart=/usr/sbin/nft -f ${rulesPath}`,
      '[Install]',
      'WantedBy=multi-user.target sshd.socket',
      ''
    ].join('\n')
  };
}

/** A drop-in that makes sshd.socket refuse to start until the firewall unit has applied the rules,
 *  closing the socket-activation boot window entirely. */
function sshdSocketGate(): {
  name: string;
  enabled: boolean;
  contents: string;
  dropins: { name: string; contents: string }[];
} {
  return {
    name: 'sshd.socket',
    enabled: true,
    contents: '',
    dropins: [
      {
        name: '10-monad-firewall.conf',
        contents: ['[Unit]', 'After=monad-firewall.service', 'Requires=monad-firewall.service', ''].join('\n')
      }
    ]
  };
}

/** The subset of the Ignition config shape callers/tests read. Loose where Ignition is (files/units
 *  are heterogeneous), typed where we assert on it. */
export interface IgnitionConfig {
  ignition: { version: string };
  passwd: { users: { name: string; sshAuthorizedKeys: string[]; groups?: string[] }[] };
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

  const gate = sshdSocketGate();
  const units: IgnitionConfig['systemd']['units'] = [
    firewallUnit(rulesPath),
    // sshd.socket: add-only drop-in (no `contents` → don't replace the shipped unit) that makes it
    // require the firewall.
    { name: gate.name, dropins: gate.dropins },
    ...spec.mounts.map(mountUnit)
  ];

  return {
    ignition: { version: '3.4.0' },
    passwd: {
      users: [
        {
          // Unprivileged, NO `wheel` group: on Fedora CoreOS wheel grants passwordless sudo, which
          // would let the agent `sudo nft flush ruleset` and defeat every confinement guarantee.
          name: 'monad',
          sshAuthorizedKeys: [spec.sshPublicKey]
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
