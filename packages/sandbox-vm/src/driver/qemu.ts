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

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

import { drainDiagnosticStream } from '../runtime/diagnostic-tail.ts';
import { type VmBaselineDriver, type VmHandle, type VmSpec } from './vfkit.ts';

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
let baselineDisabled = false;
export function configureQemuTools(t: QemuTools): void {
  tools = t;
  baselineDisabled = false;
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
  cid: number,
  incoming?: string
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
    '-qmp',
    `unix:${qmpSock(b.dir)},server=on,wait=off`,
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
    `vhost-vsock-pci,id=vsock0,guest-cid=${cid}`
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
        `vhost-user-fs-pci,id=vfsdev-${m.tag},chardev=vfs-${m.tag},tag=${m.tag}`
      );
    }
  }

  // net:'none' → no NIC. Otherwise a socket netdev wired to gvproxy's `-listen-qemu` stream socket.
  if (spec.gvproxyNetSock) {
    argv.push(
      '-netdev',
      `stream,id=net0,addr.type=unix,addr.path=${spec.gvproxyNetSock}`,
      '-device',
      `virtio-net-pci,id=nic0,netdev=net0,mac=${spec.mac}`
    );
  }

  if (incoming) argv.push('-incoming', incoming);

  return argv;
}

function qmpSock(bundleDir: string): string {
  return `${bundleDir}/qmp.sock`;
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

interface QmpResponse {
  return?: unknown;
  error?: { class?: string; desc?: string };
  event?: string;
  data?: Record<string, unknown>;
}

export class QmpClient {
  private readonly socket: ReturnType<typeof connect>;
  private buffer = '';
  private readonly messages: QmpResponse[] = [];
  private readonly waiters: Array<{ resolve(message: QmpResponse): void; reject(error: Error): void }> = [];
  private failure?: Error;

  private constructor(path: string) {
    this.socket = connect(path);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk) => {
      try {
        this.buffer += chunk;
        if (this.buffer.length > 1024 * 1024) throw new Error('qmp response exceeded limit');
        for (;;) {
          const newline = this.buffer.indexOf('\n');
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as QmpResponse;
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(message);
          else this.messages.push(message);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.on('error', (error) => this.fail(error));
  }

  static async open(path: string, timeoutMs = 5000): Promise<QmpClient> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let client: QmpClient | undefined;
      try {
        client = new QmpClient(path);
        await client.next(timeoutMs);
        await client.command('qmp_capabilities', {}, timeoutMs);
        return client;
      } catch {
        client?.close();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error('qmp socket did not become ready');
  }

  private next(timeoutMs: number): Promise<QmpResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (message: QmpResponse) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('qmp response timed out'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async command(execute: string, arguments_: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    this.socket.write(`${JSON.stringify({ execute, arguments: arguments_ })}\r\n`);
    for (;;) {
      const message = await this.next(timeoutMs);
      if (message.event) continue;
      if (message.error)
        throw new Error(`qmp ${execute}: ${message.error.class ?? 'error'}: ${message.error.desc ?? ''}`);
      return message.return;
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    this.socket.destroy();
  }
}

async function waitForMigration(client: QmpClient): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = (await client.command('query-migrate')) as { status?: string; errorDesc?: string };
    if (result.status === 'completed') return;
    if (['failed', 'cancelled'].includes(result.status ?? '')) {
      throw new Error(`qemu migration ${result.status}: ${result.errorDesc ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('qemu migration timed out');
}

async function startQemu(spec: VmSpec, restore = false): Promise<VmHandle> {
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
    if (!restore) await Bun.write(Bun.file(spec.bundle.efiVars), Bun.file(tools.firmware.vars));
    await rm(qmpSock(spec.bundle.dir), { force: true });
    for (const m of spec.mounts) {
      ownSidecar(
        Bun.spawn(
          [tools.virtiofsd, '--socket-path', virtiofsdSock(spec.bundle.dir, m.tag), '--shared-dir', m.hostPath],
          {
            stdout: 'ignore',
            stderr: 'pipe'
          }
        )
      );
    }
    ownSidecar(
      Bun.spawn([tools.socat, `UNIX-LISTEN:${spec.vsockSock},fork`, `VSOCK-CONNECT:${cid}:${spec.vsockPort}`], {
        stdout: 'ignore',
        stderr: 'pipe'
      })
    );
    const incoming = restore ? `file:${join(dirname(spec.bundle.rootfs), 'baseline-state.bin')}` : undefined;
    const qemu = Bun.spawn(
      qemuArgv(tools.qemu, spec, { firmwareCode: tools.firmware.code, kvm: tools.kvm }, cid, incoming),
      { stdout: 'pipe', stderr: 'pipe' }
    );
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

export const qemuDriver: VmBaselineDriver = {
  kind: 'qemu',
  baselineSupported: true,
  canBaseline() {
    return tools?.kvm === true && !baselineDisabled;
  },
  async boot(spec: VmSpec): Promise<VmHandle> {
    return startQemu(spec);
  },
  async captureBaseline(spec, _handle, artifactDir) {
    if (!tools?.kvm) throw new Error('qemu baseline requires KVM');
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const state = join(artifactDir, 'state.bin');
    const client = await QmpClient.open(qmpSock(spec.bundle.dir));
    let needsResume = false;
    try {
      await client.command('migrate', { uri: `file:${state}` });
      await waitForMigration(client);
      needsResume = true;
      await Promise.all([
        copyFile(spec.bundle.rootfs, join(artifactDir, 'rootfs.img')),
        copyFile(spec.bundle.efiVars, join(artifactDir, 'efivars.fd'))
      ]);
      await client.command('cont');
      needsResume = false;
    } catch (error) {
      baselineDisabled = true;
      throw error;
    } finally {
      if (needsResume) await client.command('cont').catch(() => {});
      client.close();
    }
    return ['state.bin', 'rootfs.img', 'efivars.fd'];
  },
  async restoreBaseline(spec, artifact) {
    if (!tools?.kvm) throw new Error('qemu baseline requires KVM');
    const dir = dirname(artifact.manifestPath);
    await Promise.all([
      copyFile(join(dir, 'rootfs.img'), spec.bundle.rootfs),
      copyFile(join(dir, 'efivars.fd'), spec.bundle.efiVars),
      copyFile(join(dir, 'state.bin'), join(spec.bundle.dir, 'baseline-state.bin'))
    ]);
    return startQemu(spec, true);
  },
  async invalidateBaseline(artifact) {
    await rm(dirname(artifact.manifestPath), { recursive: true, force: true });
  }
};
