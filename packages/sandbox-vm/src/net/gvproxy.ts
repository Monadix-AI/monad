// gvproxy — the gvisor-tap-vsock user-space network stack that fronts the VM's virtio-net device.
// Instead of vmnet (root, host-network exposure), the guest's NIC is a datagram socket into gvproxy,
// which runs DHCP/DNS/TCP-forwarding entirely in user space. Two things fall out of that:
//   • the guest's sshd is reachable from the host via `-forward-sock` (a host-side unix socket) with
//     no host port opened — the exec channel (see ../exec/ssh.ts);
//   • egress is mediated in-process, so `net:'filtered'` routes the guest to monad's host egress
//     proxy at the gvproxy gateway IP (the guest cannot see host loopback directly).
//
// gvproxy's default virtual network: the gateway is 192.168.127.1 and the host is reachable at
// 192.168.127.254. These are gvproxy defaults; the pool verifies them against the running gvproxy at
// boot (see the plan's spike note) rather than trusting them blindly.

export const GVPROXY_GATEWAY_IP = '192.168.127.1';
export const GVPROXY_HOST_IP = '192.168.127.254';
// The guest's own DHCP-assigned address under gvisor-tap-vsock (the first lease after the gateway).
// The ssh forward target must be the GUEST, not the gateway — forwarding to the gateway reaches
// gvproxy itself, which has no sshd.
export const GVPROXY_GUEST_IP = '192.168.127.2';

export interface GvproxySpec {
  gvproxyBin: string;
  /** vfkit ⇄ gvproxy datagram socket (vfkit connects, gvproxy listens). */
  vfkitNetSock: string;
  /** Host-side unix socket that forwards to the guest's sshd. */
  sshForwardSock: string;
  /** Guest-side port to forward from (sshd). */
  guestSshPort?: number;
}

/** Build the gvproxy argv. `-listen-vfkit` is the datagram endpoint vfkit's virtio-net attaches to;
 *  `-forward-sock` exposes the guest's sshd on a host unix socket for the exec channel. */
export function gvproxyArgv(spec: GvproxySpec): string[] {
  const guestSsh = spec.guestSshPort ?? 22;
  return [
    spec.gvproxyBin,
    '-listen-vfkit',
    `unixgram://${spec.vfkitNetSock}`,
    '-forward-sock',
    spec.sshForwardSock,
    '-forward-dst',
    `${GVPROXY_GUEST_IP}:${guestSsh}`,
    '-forward-user',
    'monad'
  ];
}

export interface GvproxyProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Spawn gvproxy. The caller owns lifecycle (kill on VM teardown). */
export function spawnGvproxy(spec: GvproxySpec): GvproxyProcess {
  const proc = Bun.spawn(gvproxyArgv(spec), { stdout: 'pipe', stderr: 'pipe' });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: () => proc.kill()
  };
}

// ── guest-side egress enforcement ────────────────────────────────────────────────────────────────
// `net:'filtered'` must be enforced INSIDE the guest, not by an injected HTTP_PROXY env var a process
// can simply unset (Cowork's "the sandbox cannot reconfigure the proxy" principle). The guest runs an
// nftables ruleset — installed by the bootstrap unit as root, before the unprivileged `monad` user
// gets a shell — that DROPs all output except loopback, DNS to the gvproxy resolver, and the host
// egress proxy. The agent runs unprivileged and cannot alter it.

export interface GuestEgressRules {
  /** 'none' → drop all egress; 'filtered' → only proxy + DNS; 'unrestricted' → no rules. */
  mode: 'none' | 'filtered' | 'unrestricted';
  /** Host egress-proxy port (reached at GVPROXY_HOST_IP:proxyPort) for 'filtered'. */
  proxyPort?: number;
}

/** Render the nftables ruleset the guest bootstrap installs for the given egress mode. Returned as
 *  text so it can be embedded in the Ignition config and unit-tested without a guest. */
export function guestNftables(rules: GuestEgressRules): string {
  if (rules.mode === 'unrestricted') {
    return '# net:unrestricted — no egress rules\n';
  }
  if (rules.mode === 'none') {
    return [
      'table inet monad {',
      '  chain output {',
      '    type filter hook output priority 0; policy drop;',
      '    oif "lo" accept',
      '    # net:none — nothing else may leave the VM',
      '  }',
      '}',
      ''
    ].join('\n');
  }
  // filtered: allow loopback, DNS to the gvproxy resolver, and TCP to the host egress proxy only.
  if (rules.proxyPort === undefined) {
    throw new Error('guestNftables: net:filtered requires a proxyPort');
  }
  return [
    'table inet monad {',
    '  chain output {',
    '    type filter hook output priority 0; policy drop;',
    '    oif "lo" accept',
    '    ct state established,related accept',
    `    ip daddr ${GVPROXY_GATEWAY_IP} udp dport 53 accept`,
    `    ip daddr ${GVPROXY_GATEWAY_IP} tcp dport 53 accept`,
    `    ip daddr ${GVPROXY_HOST_IP} tcp dport ${rules.proxyPort} accept`,
    '    # everything else dropped by policy',
    '  }',
    '}',
    ''
  ].join('\n');
}

/** The HTTP(S)_PROXY env the guest exports for well-behaved clients (belt-and-suspenders on top of
 *  the nftables enforcement — the rules are the real boundary). */
export function guestProxyEnv(proxyPort: number): Record<string, string> {
  const url = `http://${GVPROXY_HOST_IP}:${proxyPort}`;
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url };
}
