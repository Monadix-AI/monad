// The hypervisor driver. `VmDriver` is the seam a P1 native Swift/Virtualization.framework driver can
// replace; the P0 implementation shells out to vfkit (adhoc-signed, carries the virtualization
// entitlement — no Developer ID needed). vfkit talks Virtualization.framework and, unlike Apple's
// `container` CLI, lets us attach the guest NIC to gvproxy's user-space netstack (via a datagram
// socket) so egress is host-mediated.

import type { VmBundle } from '../bundle.ts';
import type { MountSpec } from '../ignition.ts';

export interface VmSpec {
  cpus: number;
  memoryMiB: number;
  bundle: VmBundle;
  mounts: MountSpec[];
  /** When set, attach a virtio-net device wired to this gvproxy datagram socket. Omit for net:'none'
   *  (no NIC at all — the strongest network isolation). */
  gvproxyNetSock?: string;
  /** Deterministic guest MAC (kept stable across a VM's restarts). */
  mac: string;
}

export interface VmDriver {
  readonly kind: string;
  /** Boot a VM from the spec and return a handle. */
  boot(spec: VmSpec): Promise<VmHandle>;
}

export interface VmHandle {
  readonly pid: number;
  readonly exited: Promise<number>;
  stop(): Promise<void>;
}

/** Build the vfkit argv from a VM spec. Pure (no spawn) so it is unit-testable. */
export function vfkitArgv(vfkitBin: string, spec: VmSpec): string[] {
  const b = spec.bundle;
  const argv: string[] = [
    vfkitBin,
    '--cpus',
    String(spec.cpus),
    '--memory',
    String(spec.memoryMiB),
    '--bootloader',
    `efi,variable-store=${b.efiVars},create`,
    '--ignition',
    b.ignition,
    '--device',
    `virtio-blk,path=${b.rootfs}`,
    '--device',
    'virtio-rng',
    '--restful-uri',
    `unix://${b.vfkitSock}`,
    '--pidfile',
    b.vfkitPid
  ];

  for (const m of spec.mounts) {
    argv.push('--device', `virtio-fs,sharedDir=${m.path},mountTag=${m.tag}`);
  }

  // net:'none' → no NIC device at all. Otherwise attach to gvproxy's datagram socket.
  if (spec.gvproxyNetSock) {
    argv.push('--device', `virtio-net,unixSocketPath=${spec.gvproxyNetSock},mac=${spec.mac}`);
  }

  return argv;
}

export const vfkitDriver: VmDriver = {
  kind: 'vfkit',
  async boot(spec: VmSpec): Promise<VmHandle> {
    const argv = vfkitArgv(this._vfkitBin ?? 'vfkit', spec);
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
    return {
      pid: proc.pid,
      exited: proc.exited,
      async stop() {
        proc.kill();
        await proc.exited;
      }
    };
  }
} as VmDriver & { _vfkitBin?: string };

/** Bind the resolved vfkit binary path into the driver (the toolchain resolves it in prepare()). */
export function configureVfkitBin(path: string): void {
  (vfkitDriver as VmDriver & { _vfkitBin?: string })._vfkitBin = path;
}
