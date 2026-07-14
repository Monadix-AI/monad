// The Windows hypervisor driver: native Hyper-V through winvm-helper (our vendored Go binary —
// Bun has no WMI/AF_HYPERV access). Chosen over QEMU+WHPX after a survey: WHPX is QEMU's
// second-tier accelerator (Linux-guest freeze bugs, no enlightenments) and Windows-host QEMU has
// no vsock, no virtio-fs, and no 9p — while the Hyper-V path is podman machine's production shape
// AND keeps the whole guest plane intact:
//   • exec — the guest agent's AF_VSOCK listener works unchanged (hvsock appears as vsock in the
//     guest); the helper's execbridge exposes it as an owner-only named pipe that node can dial.
//   • mounts — one 9p server per policy root (helper serve9p over hvsock, pinned to this VMID),
//     mounted by the agent's mount9p mode. Read-only is enforced host-side.
//   • net — gvforwarder in the guest taps to gvproxy on the host; the helper's netbridge pins the
//     vsock service to this VMID so no other VM can reach this VM's egress stack. net:'none' skips
//     all of it — no NIC exists at all, same strength as macOS.
//
// hvsock ports are FIXED (exec 1024, net 1025, 9p 1026+i) and registered once by `msvm setup`
// (elevated); per-VM isolation comes from VMID-pinned listeners, not unique ports — so steady-state
// VM lifecycle needs no admin rights beyond Hyper-V Administrators membership.
//
// Requires Windows Pro/Enterprise/Education (Hyper-V). Home has no Hyper-V; prepare() fails with a
// clear message rather than degrading to a weaker sandbox.

import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { DiagnosticTail } from '../runtime/diagnostic-tail.ts';
import { type VmBaselineDriver, type VmHandle, type VmSpec } from './vfkit.ts';

/** The fixed hvsock port plan (see module comment). */
export const HVSOCK_PORTS = {
  exec: 1024,
  net: 1025,
  mountBase: 1026,
  /** Mounts per VM cap — bounds the registered port range. */
  maxMounts: 32
} as const;

/** The full port spec `msvm setup` registers, as the helper's --ports syntax. */
export function hvsockSetupPortSpec(): string {
  const first = HVSOCK_PORTS.mountBase;
  const last = HVSOCK_PORTS.mountBase + HVSOCK_PORTS.maxMounts - 1;
  return `${HVSOCK_PORTS.exec},${HVSOCK_PORTS.net},${first}-${last}`;
}

interface HypervTools {
  /** Path to winvm-helper.exe (toolchain-resolved). */
  helper: string;
}
let tools: HypervTools | null = null;
export function configureHypervTools(t: HypervTools): void {
  tools = t;
}

interface Child {
  kill(): void;
  readonly exited: Promise<number>;
}

/** Run a one-shot helper command, parsing its single JSON stdout line. Throws on nonzero exit with
 *  the helper's JSON error line from stderr. */
async function helperRun(helper: string, args: string[]): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([helper, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new Error(`winvm-helper ${args[0]}: ${err.trim() || out.trim() || 'failed'}`);
  }
  try {
    return JSON.parse(out.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`winvm-helper ${args[0]}: unparseable output: ${out.trim()}`);
  }
}

/** How long to wait for a service's "ready" line before giving up (the listener bound but the helper
 *  stalled, or the ready line never comes). Without this the boot hangs forever — bootTimeoutMs only
 *  covers waitForVsock, which runs AFTER driver.boot() returns. */
const SERVE_READY_TIMEOUT_MS = 15_000;

/** Spawn a long-running helper service (execbridge/netbridge/serve9p) and wait for its JSON "ready"
 *  line so callers never race an unbound listener. Accumulates stdout until a full newline-terminated
 *  line (the ready JSON can arrive fragmented across pipe reads), bounded by a timeout, then keeps
 *  draining stdout in the background — a long-lived service that later logs to a full, unread pipe
 *  buffer would otherwise block on write and freeze the exec/9p channel mid-session. */
async function helperServe(helper: string, args: string[]): Promise<Child> {
  const proc = Bun.spawn([helper, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const readLine = async (): Promise<string> => {
    while (!buf.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) return buf; // stream closed before a newline — return what we have
      buf += decoder.decode(value, { stream: true });
    }
    return buf.slice(0, buf.indexOf('\n'));
  };
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`winvm-helper ${args[0]}: no ready line within ${SERVE_READY_TIMEOUT_MS}ms`)),
      SERVE_READY_TIMEOUT_MS
    ).unref?.()
  );

  let line: string;
  try {
    line = await Promise.race([readLine(), timeout]);
  } catch (error) {
    reader.releaseLock();
    proc.kill();
    throw error;
  }

  if (!line.includes('"ready"')) {
    reader.releaseLock();
    proc.kill();
    const err = await new Response(proc.stderr).text();
    throw new Error(`winvm-helper ${args[0]}: not ready: ${err.trim() || line.trim()}`);
  }

  // Keep draining BOTH pipes so the child never blocks on a full buffer over its lifetime. `reader`
  // is already held for stdout; stderr gets its own. Types are inferred from the concrete streams
  // (Bun's reader differs structurally from the DOM one) rather than a shared annotated helper.
  const drain = async (r: { read(): Promise<{ done: boolean }> }) => {
    try {
      while (!(await r.read()).done) {
        /* discard */
      }
    } catch {
      /* process gone */
    }
  };
  void drain(reader);
  void drain(proc.stderr.getReader());
  return proc;
}

/** Build the helper argv set for a boot — pure, so the port/argv plan is unit-testable without a
 *  Windows host. `vmId` is only known after `create`, hence the placeholder substituted later. */
export function hypervServiceArgv(spec: VmSpec, vmId: string): string[][] {
  const services: string[][] = [];
  for (const m of spec.mounts) {
    if (m.vsockPort === undefined) throw new Error(`hyperv: mount ${m.tag} has no vsockPort`);
    const args = ['serve9p', '--vm-id', vmId, '--port', String(m.vsockPort), '--root', m.hostPath];
    if (m.readOnly) args.push('--ro');
    services.push(args);
  }
  if (spec.gvproxyNetSock) {
    services.push([
      'netbridge',
      '--vm-id',
      vmId,
      '--port',
      String(HVSOCK_PORTS.net),
      '--connect-unix',
      spec.gvproxyNetSock
    ]);
  }
  services.push(['execbridge', '--vm-id', vmId, '--port', String(spec.vsockPort), '--pipe', spec.vsockSock]);
  return services;
}

/** Preflight for prepare(): Hyper-V usable + the fixed hvsock port range registered. Throws with
 *  actionable guidance (enable Hyper-V / run `msvm setup` elevated) — never degrade silently. */
export async function hypervPreflight(helper: string): Promise<void> {
  const probe = await helperRun(helper, ['probe']);
  if (!probe.hyperv) {
    throw new Error(
      `Hyper-V is not usable (${String(probe.detail ?? 'unknown')}). The Windows VM backend requires ` +
        'Windows Pro/Enterprise/Education with the Hyper-V feature enabled and membership in the ' +
        'Hyper-V Administrators group.'
    );
  }
  const reg = await helperRun(helper, ['setup', '--check', '--ports', hvsockSetupPortSpec()]);
  if (!reg.registered) {
    throw new Error(
      `hvsock service ports are not registered (missing: ${JSON.stringify(reg.missing)}). ` +
        'Run `msvm setup` once from an elevated shell to register them.'
    );
  }
}

async function startHypervServices(helper: string, spec: VmSpec, vmId: string): Promise<VmHandle> {
  const b = spec.bundle;
  const children: Child[] = [];
  try {
    for (const args of hypervServiceArgv(spec, vmId)) children.push(await helperServe(helper, args));
    await helperRun(helper, ['start', '--name', b.vmName]);
  } catch (error) {
    for (const child of children) child.kill();
    await helperRun(helper, ['remove', '--name', b.vmName]).catch(() => {});
    throw error;
  }
  return {
    pid: 0,
    exited: new Promise<number>(() => {}),
    diagnostics: { stdout: new DiagnosticTail(64 * 1024), stderr: new DiagnosticTail(64 * 1024) },
    async stop() {
      for (const child of children) child.kill();
      await helperRun(helper, ['remove', '--name', b.vmName]).catch(() => {});
    }
  };
}

async function artifactFiles(root: string, dir = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await artifactFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

export function hypervBaselineCreateArgv(name: string, path: string): string[] {
  return ['baseline-create', '--name', name, '--path', path];
}

export function hypervBaselineRestoreArgv(name: string, path: string): string[] {
  return ['baseline-restore', '--name', name, '--path', path];
}

export const hypervDriver: VmBaselineDriver = {
  kind: 'hyperv',
  baselineSupported: true,
  canBaseline() {
    return process.platform === 'win32' && tools !== null;
  },
  async boot(spec: VmSpec): Promise<VmHandle> {
    if (!tools) throw new Error('hyperv driver: not configured (call configureHypervTools)');
    const helper = tools.helper;
    const b = spec.bundle;

    // 1. Create the VM (attaches the bundle's vhdx; removes a stale same-name VM first) and inject
    //    the Ignition config over KVP — both must precede start.
    const created = await helperRun(helper, [
      'create',
      '--name',
      b.vmName,
      '--cpus',
      String(spec.cpus),
      '--memory',
      String(spec.memoryMiB),
      '--disk',
      b.rootfs
    ]);
    const vmId = created.vmId as string;
    if (!vmId) throw new Error('hyperv: create returned no vmId');
    await helperRun(helper, ['ignition', '--name', b.vmName, '--file', b.ignition]);

    return startHypervServices(helper, spec, vmId);
  },
  async captureBaseline(spec, _handle, artifactDir) {
    if (!tools) throw new Error('hyperv driver: not configured');
    const path = join(artifactDir, 'hyperv');
    await helperRun(tools.helper, hypervBaselineCreateArgv(spec.bundle.vmName, path));
    return artifactFiles(artifactDir);
  },
  async restoreBaseline(spec, artifact) {
    if (!tools) throw new Error('hyperv driver: not configured');
    const path = join(dirname(artifact.manifestPath), 'hyperv');
    const restored = await helperRun(tools.helper, hypervBaselineRestoreArgv(spec.bundle.vmName, path));
    const vmId = restored.vmId as string;
    if (!vmId) throw new Error('hyperv: baseline restore returned no vmId');
    return startHypervServices(tools.helper, spec, vmId);
  },
  async invalidateBaseline(artifact) {
    if (!tools) return;
    const path = join(dirname(artifact.manifestPath), 'hyperv');
    await helperRun(tools.helper, ['baseline-delete', '--path', path]).catch(() => {});
  }
};
