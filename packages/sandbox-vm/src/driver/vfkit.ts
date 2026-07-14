// The hypervisor driver. `VmDriver` is the seam a P1 native Swift/Virtualization.framework driver can
// replace; the P0 implementation shells out to vfkit (adhoc-signed, carries the virtualization
// entitlement — no Developer ID needed). vfkit talks Virtualization.framework and, unlike Apple's
// `container` CLI, lets us attach the guest NIC to gvproxy's user-space netstack (via a datagram
// socket) so egress is host-mediated.

import type { VmBundle } from '../bundle.ts';
import type { MountSpec } from '../ignition.ts';
import type { DiagnosticTail } from '../runtime/diagnostic-tail.ts';

import { drainDiagnosticStream } from '../runtime/diagnostic-tail.ts';

export interface VmSpec {
  cpus: number;
  memoryMiB: number;
  bundle: VmBundle;
  mounts: MountSpec[];
  /** When set, attach a virtio-net device wired to this gvproxy datagram socket. Omit for net:'none'
   *  (no NIC at all — the strongest network isolation; the exec channel is vsock, not the NIC). */
  gvproxyNetSock?: string;
  /** Deterministic guest MAC (kept stable across a VM's restarts). */
  mac: string;
  /** Host unix socket for the guest's vsock exec port (always present — the control plane). */
  vsockSock: string;
  /** Guest vsock port the exec agent listens on. */
  vsockPort: number;
}

export interface VmDriver {
  readonly kind: string;
  readonly baselineSupported: boolean;
  /** Boot a VM from the spec and return a handle. */
  boot(spec: VmSpec): Promise<VmHandle>;
}

export interface VmBaselineArtifact {
  readonly manifestPath: string;
  readonly identity: string;
  readonly byteSize: number;
}

export interface VmBaselineDriver extends VmDriver {
  readonly baselineSupported: true;
  captureBaseline(spec: VmSpec, handle: VmHandle, artifactDir: string): Promise<string[]>;
  restoreBaseline(spec: VmSpec, artifact: VmBaselineArtifact): Promise<VmHandle>;
  invalidateBaseline(artifact: VmBaselineArtifact): Promise<void>;
}

export function isBaselineDriver(driver: VmDriver): driver is VmBaselineDriver {
  return driver.baselineSupported === true;
}

export interface VmHandle {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly diagnostics: { stdout: DiagnosticTail; stderr: DiagnosticTail };
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
    argv.push('--device', `virtio-fs,sharedDir=${m.hostPath},mountTag=${m.tag}`);
  }

  // net:'none' → no NIC device at all. Otherwise attach to gvproxy's datagram socket.
  if (spec.gvproxyNetSock) {
    argv.push('--device', `virtio-net,unixSocketPath=${spec.gvproxyNetSock},mac=${spec.mac}`);
  }

  // The exec channel: `connect` mode means vfkit LISTENS on the host unix socket and forwards a host
  // connection to the guest's vsock port (where the agent listens). NIC-independent, so it works even
  // in net:'none' with no virtio-net device.
  argv.push('--device', `virtio-vsock,port=${spec.vsockPort},socketURL=${spec.vsockSock},connect`);

  return argv;
}

export const vfkitDriver: VmDriver = {
  kind: 'vfkit',
  baselineSupported: false,
  async boot(spec: VmSpec): Promise<VmHandle> {
    const argv = vfkitArgv(this._vfkitBin ?? 'vfkit', spec);
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
    const stdout = drainDiagnosticStream(proc.stdout);
    const stderr = drainDiagnosticStream(proc.stderr);
    let stopPromise: Promise<void> | undefined;
    return {
      pid: proc.pid,
      exited: proc.exited,
      diagnostics: { stdout: stdout.tail, stderr: stderr.tail },
      stop() {
        stopPromise ??= (async () => {
          proc.kill();
          await proc.exited.catch(() => {});
          await Promise.allSettled([stdout.done, stderr.done]);
        })();
        return stopPromise;
      }
    };
  }
} as VmDriver & { _vfkitBin?: string };

/** Bind the resolved vfkit binary path into the driver (the toolchain resolves it in prepare()). */
export function configureVfkitBin(path: string): void {
  (vfkitDriver as VmDriver & { _vfkitBin?: string })._vfkitBin = path;
}
