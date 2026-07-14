// The Linux hypervisor driver: QEMU with KVM. Chosen over Firecracker/cloud-hypervisor because it is
// the only mainstream Linux VMM that consumes gvproxy's frame-over-socket transport (`-listen-qemu`),
// so the whole macOS architecture — gvproxy egress netstack, CoreOS disk image, vsock exec, virtio-fs
// mounts — carries over. The guest plane (the vsock Go agent, Ignition, virtio-fs consumption) is
// byte-for-byte identical to the mac path; only this host driver differs.
//
// Three host helpers QEMU needs that vfkit had built in:
//   • vsock — QEMU's vhost-vsock is AF_VSOCK by guest CID (Bun can't dial AF_VSOCK), so a per-VM
//     `socat UNIX-LISTEN:<sock>,fork VSOCK-CONNECT:<cid>:<port>` bridges it back to the vfkit-style
//     host unix socket the exec channel already speaks. One socat per VM.
//   • virtio-fs — one `virtiofsd` daemon per mount tag, plus a shared memory backend (memfd).
//   • firmware — an OVMF/edk2 image to EFI-boot the CoreOS qcow2 (QEMU boots qcow2 natively).

import type { Firmware } from '../toolchain.ts';

import { drainDiagnosticStream } from '../runtime/diagnostic-tail.ts';
import { type VmDriver, type VmHandle, type VmSpec } from './vfkit.ts';

// Toolchain-resolved paths, wired once at boot (mirrors configureVfkitBin).
interface QemuTools {
  qemu: string;
  virtiofsd: string;
  socat: string;
  /** EFI code (readonly pflash) + the vars template each VM copies to a writable pflash. */
  firmware: Firmware;
  /** true when /dev/kvm is usable; false → software emulation (TCG), far slower but works for tests. */
  kvm: boolean;
}
let tools: QemuTools | null = null;
export function configureQemuTools(t: QemuTools): void {
  tools = t;
}

/** QEMU machine + accel for the host arch. arm64 → `virt`, x86_64 → `q35`; KVM when available. */
function machineArgs(kvm: boolean): string[] {
  const accel = kvm ? 'kvm' : 'tcg';
  return process.arch === 'x64'
    ? ['-machine', `q35,accel=${accel}`, '-cpu', kvm ? 'host' : 'max']
    : ['-machine', `virt,accel=${accel},gic-version=3`, '-cpu', kvm ? 'host' : 'max'];
}

/** A deterministic guest CID (>= 3) from the reuse key, stable across restarts and unique per VM. */
export function guestCidFor(key: string): number {
  const h = new Bun.CryptoHasher('sha256').update(key).digest('hex');
  // 3 .. 0xFFFFFFFE (0,1,2 are reserved; 0xFFFFFFFF is -1U).
  return 3 + (Number.parseInt(h.slice(0, 8), 16) % 0xfffffff0);
}

/** Build the QEMU argv from a VM spec. Pure (no spawn) so it is unit-testable. `t.firmwareCode` is the
 *  readonly EFI code pflash; the writable vars pflash is the per-VM `bundle.efiVars` copy (the driver
 *  writes it before boot). On aarch64 `virt` BOTH pflash images must be exactly 64 MiB. */
export function qemuArgv(
  qemuBin: string,
  spec: VmSpec,
  t: { firmwareCode: string; kvm: boolean },
  cid: number
): string[] {
  const b = spec.bundle;
  const argv: string[] = [
    qemuBin,
    ...machineArgs(t.kvm),
    '-m',
    String(spec.memoryMiB),
    '-smp',
    String(spec.cpus),
    '-nographic',
    '-nodefaults',
    '-serial',
    'null',
    // EFI firmware: readonly code + a writable per-VM vars store (both 64 MiB on aarch64 virt).
    '-drive',
    `if=pflash,format=raw,unit=0,readonly=on,file=${t.firmwareCode}`,
    '-drive',
    `if=pflash,format=raw,unit=1,file=${b.efiVars}`,
    '-drive',
    `file=${b.rootfs},if=virtio,format=qcow2`,
    // Ignition is delivered over the fw_cfg channel CoreOS reads on QEMU.
    '-fw_cfg',
    `name=opt/com.coreos/config,file=${b.ignition}`,
    '-device',
    'virtio-rng-pci',
    // vsock: vhost-vsock with a unique guest CID; the socat bridge (spawned separately) exposes it as
    // the host unix socket the exec channel dials.
    '-device',
    `vhost-vsock-pci,guest-cid=${cid}`
  ];

  // virtio-fs needs a shared memory backend so the daemon and guest map the same pages.
  if (spec.mounts.length > 0) {
    argv.push('-object', `memory-backend-memfd,id=mem,size=${spec.memoryMiB}M,share=on`, '-numa', 'node,memdev=mem');
    for (const m of spec.mounts) {
      const sock = virtiofsdSock(b.dir, m.tag);
      argv.push(
        '-chardev',
        `socket,id=vfs-${m.tag},path=${sock}`,
        '-device',
        `vhost-user-fs-pci,chardev=vfs-${m.tag},tag=${m.tag}`
      );
    }
  }

  // net:'none' → no NIC. Otherwise a socket netdev wired to gvproxy's `-listen-qemu` stream socket.
  if (spec.gvproxyNetSock) {
    argv.push(
      '-netdev',
      `stream,id=net0,addr.type=unix,addr.path=${spec.gvproxyNetSock}`,
      '-device',
      `virtio-net-pci,netdev=net0,mac=${spec.mac}`
    );
  }

  return argv;
}

/** The per-mount virtiofsd control socket path (inside the bundle dir). */
export function virtiofsdSock(bundleDir: string, tag: string): string {
  return `${bundleDir}/vfsd-${tag}.sock`;
}

interface Child {
  kill(): void;
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export const qemuDriver: VmDriver = {
  kind: 'qemu',
  async boot(spec: VmSpec): Promise<VmHandle> {
    if (!tools) throw new Error('qemu driver: not configured (call configureQemuTools)');
    const cid = guestCidFor(spec.bundle.key);
    const children: Array<{ process: Child; drain: Promise<void> }> = [];

    const ownSidecar = (process: Child) => {
      children.push({ process, drain: drainDiagnosticStream(process.stderr).done });
    };

    const stopSidecars = async () => {
      for (const child of children) child.process.kill();
      await Promise.allSettled(children.flatMap((child) => [child.process.exited, child.drain]));
    };

    try {
      // 0. Per-VM writable EFI vars store: copy the firmware's vars template into the bundle. QEMU
      //    persists EFI variables here, and (on aarch64 virt) it must match the code pflash's 64 MiB.
      await Bun.write(Bun.file(spec.bundle.efiVars), Bun.file(tools.firmware.vars));

      // 1. One virtiofsd per mount tag (must be up before QEMU connects the chardev).
      for (const m of spec.mounts) {
        ownSidecar(
          Bun.spawn([tools.virtiofsd, '--socket-path', virtiofsdSock(spec.bundle.dir, m.tag), '--shared-dir', m.path], {
            stdout: 'ignore',
            stderr: 'pipe'
          })
        );
      }

      // 2. The vsock bridge: expose the guest's AF_VSOCK port as the bundle's host unix socket.
      ownSidecar(
        Bun.spawn([tools.socat, `UNIX-LISTEN:${spec.vsockSock},fork`, `VSOCK-CONNECT:${cid}:${spec.vsockPort}`], {
          stdout: 'ignore',
          stderr: 'pipe'
        })
      );

      // 3. QEMU itself.
      const qemu = Bun.spawn(qemuArgv(tools.qemu, spec, { firmwareCode: tools.firmware.code, kvm: tools.kvm }, cid), {
        stdout: 'pipe',
        stderr: 'pipe'
      });
      const stdout = drainDiagnosticStream(qemu.stdout);
      const stderr = drainDiagnosticStream(qemu.stderr);
      const exited = Promise.race([qemu.exited, ...children.map((child) => child.process.exited)]);
      let stopPromise: Promise<void> | undefined;

      return {
        pid: qemu.pid,
        exited,
        diagnostics: { stdout: stdout.tail, stderr: stderr.tail },
        stop() {
          stopPromise ??= (async () => {
            qemu.kill();
            await stopSidecars();
            await Promise.allSettled([qemu.exited, stdout.done, stderr.done]);
          })();
          return stopPromise;
        }
      };
    } catch (error) {
      await stopSidecars();
      throw error;
    }
  }
};
