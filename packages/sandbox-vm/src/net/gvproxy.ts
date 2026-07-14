// gvproxy — the gvisor-tap-vsock user-space network stack that fronts the VM's virtio-net device.
// Instead of vmnet (root, host-network exposure), the guest's NIC is a datagram socket into gvproxy,
// which runs DHCP/DNS/TCP-forwarding entirely in user space. It is ONLY the egress netstack: the
// exec channel is vsock (see ../exec/vsock.ts), not ssh, so gvproxy's `-ssh-port` host-loopback
// forward is explicitly disabled (`-ssh-port -1`, see gvproxyArgv) — it would otherwise bind a
// per-VM host port and collide across concurrent VMs. Egress is mediated in-process, so
// `net:'filtered'` routes the guest to monad's host egress proxy at the gvproxy gateway IP (the
// guest cannot see host loopback directly).
//
// gvproxy's virtual network: gateway 192.168.127.1, host reachable at 192.168.127.254, and a DHCP
// static lease pins the guest to 192.168.127.2 by its MAC (see ignition.ts).

export const GVPROXY_GATEWAY_IP = '192.168.127.1';
export const GVPROXY_HOST_IP = '192.168.127.254';

export interface GvproxySpec {
  gvproxyBin: string;
  /** The host socket gvproxy exposes for the VMM's virtio-net device (or, on Windows, for the
   *  helper's VMID-pinned netbridge to forward the guest's gvforwarder tunnel into). */
  netSock: string;
  /** The VMM's frame transport: vfkit uses a datagram socket (`-listen-vfkit`), QEMU a length-prefixed
   *  stream (`-listen-qemu`). Hyper-V uses gvforwarder's `/connect` tunnel protocol, served on a plain
   *  `-listen` endpoint — an AF_UNIX socket here, fronted per-VM by winvm-helper's netbridge (gvproxy's
   *  own hvsock listener would accept ANY VM). gvproxy has no TAP/Firecracker/cloud-hypervisor mode,
   *  which is why the Linux driver is QEMU. */
  transport: 'vfkit' | 'qemu' | 'hyperv';
}

/** gvproxy parses its `-listen`/`-listen-qemu` endpoint with url.Parse, which treats backslashes as
 *  part of the (empty-terminated) authority — so a raw Windows path yields an EMPTY listen path and
 *  gvproxy never binds. gvproxy's own Windows handling expects forward slashes behind a `unix:///`
 *  triple slash (it strips the one leading slash): `unix:///C:/dir/gvproxy.sock` → `C:/dir/…`. */
function unixEndpoint(netSock: string): string {
  if (process.platform === 'win32') return `unix:///${netSock.replace(/\\/g, '/')}`;
  return `unix://${netSock}`;
}

/** Build the gvproxy argv. gvproxy is only the guest's egress netstack (DHCP/DNS/NAT for
 *  net:'filtered'/'unrestricted'); the exec channel is vsock, so ssh forwarding is disabled —
 *  gvproxy's DEFAULT is a host-loopback ssh forward port (2222), which would collide across VMs.
 *  `-ssh-port -1` is gvproxy's documented disable sentinel (see cmd/gvproxy getForwardsMap). */
export function gvproxyArgv(spec: GvproxySpec): string[] {
  const noSsh = ['-ssh-port', '-1'];
  if (spec.transport === 'qemu') return [spec.gvproxyBin, ...noSsh, '-listen-qemu', unixEndpoint(spec.netSock)];
  if (spec.transport === 'hyperv') return [spec.gvproxyBin, ...noSsh, '-listen', unixEndpoint(spec.netSock)];
  return [spec.gvproxyBin, ...noSsh, '-listen-vfkit', `unixgram://${spec.netSock}`];
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
// can simply unset — the sandbox must not be able to reconfigure its own proxy. The guest runs an
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
    // The exec channel is vsock (NIC-independent), so net:none boots with NO network device at all —
    // the strongest isolation. This ruleset is therefore defense-in-depth: if a NIC ever exists, drop
    // everything but loopback, DHCP, and already-established return traffic; every NEW outbound
    // connection is dropped. The agent runs unprivileged and cannot alter it.
    return [
      'table inet monad {',
      '  chain output {',
      '    type filter hook output priority 0; policy drop;',
      '    oif "lo" accept',
      '    ct state established,related accept',
      `    ip daddr ${GVPROXY_GATEWAY_IP} udp dport 67 accept`,
      '    # net:none — DHCP only; no new external connections',
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
