// @monad/sandbox-vm — the built-in macOS/Linux/Windows VM sandbox backend. It is registered directly
// by the daemon and selected only when the VM backend is explicit. Unlike the light
// OS launchers it does not wrap() argv — it runs each command inside a per-agent Fedora CoreOS VM
// (own kernel, own filesystem, own process table) over a vsock exec channel, and returns a
// SandboxProcess the daemon's seam bridges onto its callers.
//
// Isolation model, per SandboxPolicy:
//   • writableRoots / readableRoots → shared-directory mounts (virtio-fs on macOS/Linux; 9p-over-
//     hvsock on Windows, where guest paths are the /mnt/<drive>/… translation of the host roots);
//     readDenyRoots simply aren't mounted (they don't exist in the guest).
//   • the exec channel is vsock (NIC-independent), so net:'none' runs with NO network device at all;
//     'filtered'/'unrestricted' get a NIC into gvproxy's user-space netstack, and egress is enforced
//     by an in-guest nftables ruleset the unprivileged workload can't alter.
//
// Per-platform drivers: vfkit (macOS), QEMU+KVM (Linux), Hyper-V via winvm-helper (Windows —
// Pro/Enterprise/Education; see driver/hyperv.ts for why not QEMU+WHPX).
//
// Reuse is per-agent (one VM across an agent's sessions); see pool.ts for the lifecycle state machine.

import type { SandboxLauncher, SandboxPolicy, SandboxProcess, SandboxSpawnOptions } from '@monad/sdk-atom';
import type { MountSpec } from './ignition.ts';

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { destroyBundle, ensureBundle, type VmBundle } from './bundle.ts';
import { configureHypervTools, HVSOCK_PORTS, hypervDriver, hypervPreflight } from './driver/hyperv.ts';
import { configureQemuTools, qemuDriver } from './driver/qemu.ts';
import { configureVfkitBin, type VmHandle, vfkitDriver } from './driver/vfkit.ts';
import { VSOCK_PROTOCOL_VERSION } from './exec/protocol.ts';
import { bridgeAsyncProcess, vsockExec, waitForVsock } from './exec/vsock.ts';
import { IGNITION_SCHEMA_VERSION, serializeIgnition } from './ignition.ts';
import { ensureBaseImage, type ImageConsent } from './image.ts';
import { type GvproxyProcess, guestProxyEnv, spawnGvproxy } from './net/gvproxy.ts';
import { effectiveVmIdentity, POOL_DEFAULTS, type PoolConfig, reuseKey, VmPool, vmKey } from './pool.ts';
import { resolveVmToolchain, vmToolchainMaybeAvailable } from './toolchain.ts';
import { sha256OfFile } from './util.ts';
import { toGuestPath, translateArgvPaths } from './winpath.ts';

// The guest binaries (Linux), vendored next to the package: the vsock exec agent (all platforms) and
// gvforwarder (Windows only — the guest's tap⇄vsock network forwarder). The guest arch matches the
// host (a hypervisor runs same-arch guests), so pick by process.arch. Injected via Ignition; read
// once and cached as base64.
const AGENT_ARCH = process.arch === 'x64' ? 'amd64' : 'arm64';
const AGENT_PATH = join(dirname(import.meta.dir), 'vendor', `vsock-agent-${AGENT_ARCH}`);
const GVFORWARDER_PATH = join(dirname(import.meta.dir), 'vendor', `gvforwarder-${AGENT_ARCH}`);
const VSOCK_EXEC_PORT = HVSOCK_PORTS.exec; // 1024 on every platform — the agent's listen port
let agentArtifact: { b64: string; digest: string } | null = null;
async function guestAgentArtifact(): Promise<{ b64: string; digest: string }> {
  if (agentArtifact === null) {
    const bytes = await Bun.file(AGENT_PATH).bytes();
    agentArtifact = {
      b64: Buffer.from(bytes).toString('base64'),
      digest: new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    };
  }
  return agentArtifact;
}
let gvforwarderB64Cache: string | null = null;
async function gvforwarderBinaryB64(): Promise<string> {
  if (gvforwarderB64Cache === null) {
    gvforwarderB64Cache = Buffer.from(await Bun.file(GVFORWARDER_PATH).bytes()).toString('base64');
  }
  return gvforwarderB64Cache;
}

export class VmBackendNotReadyError extends Error {
  constructor(message: string) {
    super(`@monad/sandbox-vm: ${message}`);
    this.name = 'VmBackendNotReadyError';
  }
}

// ── configuration (wired at daemon boot, mirroring configureE2bApiKey) ────────────────────────────

interface VmConfig extends PoolConfig {
  cpus: number;
  memoryMiB: number;
  /** How long to wait for a freshly-booted guest to become exec-reachable (CoreOS boot + Ignition). */
  bootTimeoutMs: number;
  /** Consent gate for the first image download. */
  imageConsent: ImageConsent;
}

let config: VmConfig = {
  ...POOL_DEFAULTS,
  cpus: 2,
  memoryMiB: 2048,
  bootTimeoutMs: 120_000,
  // Default-deny until the daemon wires a real prompt: never silently pull a multi-GB image.
  imageConsent: async () => false
};

export function configureVmBackend(cfg: Partial<VmConfig>): void {
  config = { ...config, ...cfg };
}

// ── per-VM runtime: a booted vfkit + its gvproxy + the bundle ──────────────────────────────────────

interface RunningVm {
  bundle: VmBundle;
  vfkit: VmHandle;
  /** Only present for net:'filtered'/'unrestricted' — net:'none' has no NIC and no gvproxy. */
  gvproxy?: GvproxyProcess;
}

interface BaseImageArtifact {
  path: string;
  digest: string;
}

let baseImage: BaseImageArtifact | null = null;
let pool: VmPool<RunningVm> | null = null;

// A deterministic MAC per reuse key (stable across a VM's restarts): 02:xx… locally-administered.
function macFor(key: string): string {
  const h = new Bun.CryptoHasher('sha256').update(key).digest('hex');
  const oct = (i: number) => h.slice(i * 2, i * 2 + 2);
  return `02:${oct(0)}:${oct(1)}:${oct(2)}:${oct(3)}:${oct(4)}`;
}

/** Canonicalize a path for containment comparison: Windows paths are translated to their guest form
 *  and lowercased (NTFS is case-insensitive — `C:\Secrets` nested under `c:\secrets` must not slip
 *  the read-deny guard); POSIX paths pass through. */
function canonPath(p: string): string {
  return process.platform === 'win32' ? toGuestPath(p).toLowerCase() : p;
}

/** True when `child` is at or below `parent` in the filesystem tree. */
function isUnder(child: string, parent: string): boolean {
  const c = canonPath(child);
  const par = canonPath(parent);
  const p = par.endsWith('/') ? par : `${par}/`;
  return c === par || c.startsWith(p);
}

/** Map the policy's roots to shared-directory mounts (virtio-fs on macOS/Linux, 9p-over-hvsock on
 *  Windows — where each mount also gets its guest path translation and fixed vsock port). Exported
 *  for conformance tests (the read-deny nesting guard is a security check). */
export function mountsFor(policy: SandboxPolicy): MountSpec[] {
  // A readDenyRoot nested under an allowed (writable/readable) root would be exposed anyway: the
  // share exposes the whole subtree, and this backend has no way to subtract a denied subpath
  // (unlike Seatbelt's deny-over-allow). Rather than silently leak the secret while advertising
  // enforces.readDeny, fail closed. (A future impl could overlay a tmpfs at each denied path.)
  const allowed = [...(policy.writableRoots ?? []), ...(policy.readableRoots ?? [])];
  for (const deny of policy.readDenyRoots ?? []) {
    for (const root of allowed) {
      if (isUnder(deny, root)) {
        throw new VmBackendNotReadyError(
          `read-deny path ${deny} is nested under mounted root ${root}; the VM backend cannot subtract a denied subpath (would expose it). Narrow the mounted root or drop the deny.`
        );
      }
    }
  }
  const mounts: MountSpec[] = [];
  let i = 0;
  for (const root of policy.writableRoots ?? []) mounts.push({ tag: `w${i++}`, path: root, readOnly: false });
  let j = 0;
  for (const root of policy.readableRoots ?? []) mounts.push({ tag: `r${j++}`, path: root, readOnly: true });
  return process.platform === 'win32' ? withHvsockMountPlan(mounts) : mounts;
}

/** Assign each Windows mount its guest path (drive-letter translation) and its fixed hvsock port.
 *  Exported for unit tests (pure). */
export function withHvsockMountPlan(mounts: MountSpec[]): MountSpec[] {
  if (mounts.length > HVSOCK_PORTS.maxMounts) {
    throw new VmBackendNotReadyError(
      `policy has ${mounts.length} roots; the Windows VM backend supports at most ${HVSOCK_PORTS.maxMounts}`
    );
  }
  return mounts.map((m, i) => ({
    ...m,
    guestPath: toGuestPath(m.path),
    vsockPort: HVSOCK_PORTS.mountBase + i
  }));
}

// Map the policy's net mode. A policy with net UNDEFINED fails CLOSED to 'none' (no egress): an
// unset network policy reaching a sandbox must never mean "open the network". The daemon always sets
// net explicitly via buildSandboxPolicy, so undefined here means a raw/misconstructed policy.
function egressFor(policy: SandboxPolicy): { mode: 'none' | 'filtered' | 'unrestricted'; proxyPort?: number } {
  if (policy.net === 'unrestricted') return { mode: 'unrestricted' };
  if (policy.net === undefined || policy.net === 'none') return { mode: 'none' };
  return { mode: 'filtered', proxyPort: policy.net.allowProxyPort };
}

// The base image is pulled lazily on first boot (it is multi-GB — never block daemon startup on it).
// Cached in `baseImage` after the first successful download, gated by the consent callback.
let baseImagePromise: Promise<BaseImageArtifact> | null = null;
function ensureBaseImageOnce(): Promise<BaseImageArtifact> {
  if (baseImage) return Promise.resolve(baseImage);
  if (!baseImagePromise) {
    baseImagePromise = ensureBaseImage(config.imageConsent).then(async (path) => {
      baseImage = { path, digest: await sha256OfFile(path) };
      return baseImage;
    });
  }
  return baseImagePromise;
}

interface VmShapeConfig {
  cpus: number;
  memoryMiB: number;
  bootTimeoutMs: number;
}

async function bootVm(
  key: string,
  policy: SandboxPolicy,
  image: BaseImageArtifact,
  shape: VmShapeConfig
): Promise<RunningVm> {
  const bundle = await ensureBundle(key, image.path);
  const mounts = mountsFor(policy);
  const egress = egressFor(policy);
  const proxyEnv = egress.mode === 'filtered' && egress.proxyPort ? guestProxyEnv(egress.proxyPort) : undefined;

  const win = process.platform === 'win32';

  // Ignition: inject the vsock exec agent, the mounts, the egress firewall — and on Windows the
  // 9p mount transport plus (net≠none) the gvforwarder tap so the guest can reach gvproxy.
  const ignition = serializeIgnition({
    agentBinaryB64: (await guestAgentArtifact()).b64,
    mounts,
    egress,
    env: proxyEnv,
    ...(win
      ? {
          mountTransport: '9p-vsock' as const,
          ...(egress.mode !== 'none'
            ? { gvforwarderB64: await gvforwarderBinaryB64(), netVsockPort: HVSOCK_PORTS.net }
            : {})
        }
      : {})
  });
  await Bun.write(bundle.ignition, ignition);

  // The exec channel is vsock (NIC-independent), so net:'none' runs with NO NIC and NO gvproxy — the
  // strongest network isolation. Only 'filtered'/'unrestricted' attach a NIC to gvproxy's user-space
  // netstack for egress. When there is a NIC, start gvproxy first and wait for its socket so the VMM's
  // virtio-net can attach at boot.
  const transport = process.platform === 'darwin' ? 'vfkit' : win ? 'hyperv' : 'qemu';
  let gvproxy: GvproxyProcess | undefined;
  let gvproxyNetSock: string | undefined;
  if (egress.mode !== 'none') {
    if (!resolvedGvproxy) throw new VmBackendNotReadyError('gvproxy not resolved (call prepare())');
    // gvproxy fatally exits if its listen socket path already exists (stale socket from a prior boot).
    await rm(bundle.gvproxySock, { force: true });
    gvproxy = spawnGvproxy({ gvproxyBin: resolvedGvproxy, netSock: bundle.gvproxySock, transport });
  }

  // Everything after gvproxy spawns can throw (waitForSocket / driver.boot / waitForVsock); a throw
  // must kill gvproxy and stop the VMM, or every failed boot orphans a gvproxy (and possibly a VM).
  try {
    if (gvproxy) {
      await waitForSocket(bundle.gvproxySock, 5000);
      gvproxyNetSock = bundle.gvproxySock;
    }
    // On Windows vsockSock is a named-pipe path (no filesystem entry to clear).
    if (!win) await rm(bundle.vsockSock, { force: true });
    const driver = process.platform === 'darwin' ? vfkitDriver : win ? hypervDriver : qemuDriver;
    const vmHandle = await driver.boot({
      cpus: shape.cpus,
      memoryMiB: shape.memoryMiB,
      bundle,
      mounts,
      gvproxyNetSock,
      mac: macFor(key),
      vsockSock: bundle.vsockSock,
      vsockPort: VSOCK_EXEC_PORT
    });

    const vm: RunningVm = { bundle, vfkit: vmHandle, gvproxy };
    liveVms.add(vm);
    // driver.boot() returns as soon as the VMM process is spawned, NOT when the guest is up. Fedora
    // CoreOS takes ~30-60s to boot + apply Ignition + start the agent, so wait until the guest is
    // exec-reachable before returning — otherwise the first command races an unbooted guest. On a
    // timeout, tear down the VM too (not just gvproxy) so a half-booted guest never leaks.
    try {
      await waitForVsock({ socketPath: bundle.vsockSock }, { timeoutMs: shape.bootTimeoutMs });
    } catch (error) {
      liveVms.delete(vm);
      await vmHandle.stop().catch(() => {});
      throw error;
    }
    return vm;
  } catch (error) {
    gvproxy?.kill();
    throw error;
  }
}

/** Poll for a socket path to appear (gvproxy binds it asynchronously after fork). */
async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new VmBackendNotReadyError(`gvproxy did not create its socket at ${path} within ${timeoutMs}ms`);
}

// Every running VM, so a daemon shutdown (SIGTERM/SIGINT/exit) can kill vfkit + gvproxy instead of
// orphaning them — they are spawned inside this package, not through the daemon's tracked spawn seam.
const liveVms = new Set<RunningVm>();

async function stopVm(vm: RunningVm): Promise<void> {
  liveVms.delete(vm);
  await vm.vfkit.stop().catch(() => {});
  vm.gvproxy?.kill();
  await destroyBundle(vm.bundle.key);
}

let resolvedGvproxy: string | null = null;

// ── the launcher ──────────────────────────────────────────────────────────────────────────────────

export const vmLauncher: SandboxLauncher = {
  kind: 'vm',
  descriptor: {
    name: 'Virtual machine',
    description: 'Runs commands inside a reusable local Fedora CoreOS VM.',
    settings: {
      fields: [
        { id: 'cpus', type: 'number', label: 'CPUs', defaultValue: 2, min: 1, max: 16 },
        { id: 'memoryMiB', type: 'number', label: 'Memory (MiB)', defaultValue: 2048, min: 512 },
        { id: 'bootTimeoutMs', type: 'number', label: 'Boot timeout (ms)', defaultValue: 120_000, min: 10_000 }
      ]
    }
  },
  platforms: ['darwin', 'linux', 'win32'],
  enforces: { writeConfine: true, readDeny: true, net: ['none', 'filtered', 'unrestricted'] },
  isAvailable: () => vmToolchainMaybeAvailable(),
  configure(settings): void {
    configureVmBackend({
      cpus: settings.cpus as number | undefined,
      memoryMiB: settings.memoryMiB as number | undefined,
      bootTimeoutMs: settings.bootTimeoutMs as number | undefined
    });
  },

  async prepare(): Promise<void> {
    // Resolve the host tooling (detect or download). The base image is pulled lazily on first spawn —
    // never block daemon boot on a multi-GB download.
    const tools = await resolveVmToolchain();
    resolvedGvproxy = tools.gvproxy;
    if (process.platform === 'darwin') {
      configureVfkitBin(tools.hypervisor);
    } else if (process.platform === 'win32') {
      configureHypervTools({ helper: tools.hypervisor });
      try {
        await hypervPreflight(tools.hypervisor);
      } catch (error) {
        throw new VmBackendNotReadyError(error instanceof Error ? error.message : String(error));
      }
    } else {
      if (!tools.firmware) throw new VmBackendNotReadyError('no EFI firmware resolved');
      configureQemuTools({
        qemu: tools.hypervisor,
        virtiofsd: tools.virtiofsd ?? '',
        socat: tools.socat ?? '',
        firmware: tools.firmware,
        kvm: tools.kvm ?? false
      });
    }
    pool = new VmPool<RunningVm>(config, { stop: stopVm });
    installShutdownHandler();
  },

  spawn(argv: string[], options: SandboxSpawnOptions, policy: SandboxPolicy): SandboxProcess {
    const activePool = pool;
    if (!activePool) throw new VmBackendNotReadyError('not prepared — prepare() must run before spawn()');
    const scope = config.scope;
    const shape = { cpus: config.cpus, memoryMiB: config.memoryMiB, bootTimeoutMs: config.bootTimeoutMs };
    const reuse = reuseKey(scope, options.sessionId, options.agentId);
    let acquiredKey: string | undefined;
    // acquire() is async (boot); the SandboxProcess must be returned synchronously, so bridge the
    // async acquire + vsock exec. The policy is captured in the boot thunk (no module-level side table).
    return bridgeAsyncProcess(
      async () => {
        const [image, agent] = await Promise.all([ensureBaseImageOnce(), guestAgentArtifact()]);
        const identity = effectiveVmIdentity(policy, {
          agentDigest: agent.digest,
          baseImageDigest: image.digest,
          cpus: shape.cpus,
          ignitionSchemaVersion: IGNITION_SCHEMA_VERSION,
          memoryMiB: shape.memoryMiB,
          protocolVersion: VSOCK_PROTOCOL_VERSION,
          runIsolation: { memoryMiB: 1024, maxProcesses: 256, terminateGraceMs: 5000 },
          vsockPort: VSOCK_EXEC_PORT
        });
        const key = vmKey(scope, options.sessionId, options.agentId, identity);
        acquiredKey = key;
        const vm = await activePool.acquire(key, reuse, options.agentId, () => bootVm(key, policy, image, shape));
        const egress = egressFor(policy);
        // On Windows, host paths (C:\…) must become their /mnt/<drive>/… guest mounts — for the cwd
        // and for any argv token that is itself an absolute Windows path. Identity on mac/linux.
        return vsockExec(translateArgvPaths(argv), {
          socketPath: vm.bundle.vsockSock,
          cwd: options.cwd !== undefined ? toGuestPath(options.cwd) : undefined,
          limits: options.limits,
          env: {
            ...options.env,
            ...(egress.mode === 'filtered' && egress.proxyPort ? guestProxyEnv(egress.proxyPort) : {})
          }
        });
      },
      () => {
        if (acquiredKey) activePool.release(acquiredKey);
      }
    );
  },

  async disposeSession(sessionId: string): Promise<void> {
    await pool?.disposeSession(sessionId);
  },

  async disposeAgent(agentId: string): Promise<void> {
    await pool?.disposeAgent(agentId);
  },

  async disposeIdle(): Promise<void> {
    await pool?.disposeIdle();
  }
};

// Kill every running VM's vfkit + gvproxy on daemon shutdown so they aren't orphaned across restarts.
let shutdownInstalled = false;
function installShutdownHandler(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const killAll = () => {
    for (const vm of liveVms) {
      try {
        vm.vfkit.stop();
      } catch {
        /* best-effort */
      }
      vm.gvproxy?.kill();
    }
  };
  process.once('exit', killAll);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(sig, () => {
      killAll();
    });
  }
}

export type { VmScope } from './pool.ts';

export { configureVmToolchain } from './toolchain.ts';
