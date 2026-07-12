// gvproxy — the gvisor-tap-vsock user-space network stack that fronts the VM's virtio-net device.
// Instead of vmnet (root, host-network exposure), the guest's NIC is a datagram socket into gvproxy,
// which runs DHCP/DNS/TCP-forwarding entirely in user space. Two things fall out of that:
//   • the guest's sshd is reachable from the host via gvproxy's `-ssh-port` (a host-loopback TCP port
//     that tunnels to the guest's sshd) — the exec channel (see ../exec/ssh.ts);
//   • egress is mediated in-process, so `net:'filtered'` routes the guest to monad's host egress
//     proxy at the gvproxy gateway IP (the guest cannot see host loopback directly).
//
// gvproxy's virtual network: gateway 192.168.127.1, host reachable at 192.168.127.254, and `-ssh-port`
// forwards to a hardcoded guest 192.168.127.2 — so the guest is pinned to .2 (see ignition.ts).

export const GVPROXY_GATEWAY_IP = '192.168.127.1';
export const GVPROXY_HOST_IP = '192.168.127.254';

export interface GvproxySpec {
  gvproxyBin: string;
  /** The host socket gvproxy exposes for the VMM's virtio-net device. */
  netSock: string;
  /** The VMM's frame transport: vfkit uses a datagram socket (`-listen-vfkit`), QEMU a length-prefixed
   *  stream (`-listen-qemu`). gvproxy has no TAP/Firecracker/cloud-hypervisor mode, which is why the
   *  Linux driver is QEMU. */
  transport: 'vfkit' | 'qemu';
}

/** Build the gvproxy argv. gvproxy is only the guest's egress netstack (DHCP/DNS/NAT for
 *  net:'filtered'/'unrestricted'); the exec channel is vsock, so no ssh port forwarding is needed. */
export function gvproxyArgv(spec: GvproxySpec): string[] {
  return spec.transport === 'qemu'
    ? [spec.gvproxyBin, '-listen-qemu', `unix://${spec.netSock}`]
    : [spec.gvproxyBin, '-listen-vfkit', `unixgram://${spec.netSock}`];
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
    // The exec channel is ssh over gvproxy's -ssh-port, so the guest ALWAYS has a NIC (the control
    // plane rides it). "No egress" is therefore enforced here, not by removing the NIC: allow only
    // loopback, DHCP (to get an address), and the return traffic of already-established connections
    // (the inbound ssh session). Every NEW outbound connection — i.e. all external egress — is
    // dropped. The agent runs unprivileged and cannot alter this. (A future vsock exec channel would
    // let net:none drop the NIC entirely for a stronger guarantee.)
    return [
      'table inet monad {',
      '  chain output {',
      '    type filter hook output priority 0; policy drop;',
      '    oif "lo" accept',
      '    ct state established,related accept',
      `    ip daddr ${GVPROXY_GATEWAY_IP} udp dport 67 accept`,
      '    # net:none — DHCP + the ssh return path only; no new external connections',
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
    `    ip daddr ${GVPROXY_GATEWAY_IP} udp dport 67 accept`,
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
