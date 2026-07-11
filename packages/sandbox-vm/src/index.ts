// @monad/sandbox-vm — the macOS VM sandbox backend. A heavy launcher (like docker/e2b) registered
// through @monad/monad-power-pack; selected only when config.sandbox.backend = 'vm'. Unlike the light
// OS launchers it does not wrap() argv — it runs each command inside a per-agent Fedora CoreOS VM
// (own kernel, own filesystem, own process table) over ssh, and returns a SandboxProcess the daemon's
// seam bridges onto its callers.
//
// Isolation model, per SandboxPolicy:
//   • writableRoots / readableRoots → virtio-fs mounts at the same guest paths (argv unchanged);
//     readDenyRoots simply aren't mounted (they don't exist in the guest).
//   • gvproxy provides a host-only SSH control path in every mode; in-guest nftables blocks new
//     outbound connections for net:'none', restricts filtered mode to the host proxy, and leaves
//     unrestricted mode open (enforced by the kernel, not an env var the agent can unset).
//
// Reuse is per-agent (one VM across an agent's sessions); see pool.ts for the lifecycle state machine.

import type { SandboxLauncher, SandboxPolicy, SandboxProcess, SandboxSpawnOptions } from '@monad/sdk-atom';
import type { MountSpec } from './ignition.ts';

import { existsSync } from 'node:fs';

import { destroyBundle, ensureBundle, type VmBundle } from './bundle.ts';
import { configureVfkitBin, type VmHandle, vfkitDriver } from './driver/vfkit.ts';
import { bridgeAsyncProcess, sshExec, waitForSsh } from './exec/ssh.ts';
import { serializeIgnition } from './ignition.ts';
import { ensureBaseImage, type ImageConsent } from './image.ts';
import { type GvproxyProcess, guestProxyEnv, spawnGvproxy } from './net/gvproxy.ts';
import { POOL_DEFAULTS, type PoolConfig, reuseKey, VmPool, vmKey } from './pool.ts';
import { resolveVmToolchain, vmToolchainMaybeAvailable } from './toolchain.ts';

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
  /** Consent gate for the first image download. */
  imageConsent: ImageConsent;
}

let config: VmConfig = {
  ...POOL_DEFAULTS,
  cpus: 2,
  memoryMiB: 2048,
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
  gvproxy?: GvproxyProcess;
}

let baseImage: string | null = null;
let pool: VmPool<RunningVm> | null = null;

// A deterministic MAC per reuse key (stable across a VM's restarts): 02:xx… locally-administered.
function macFor(key: string): string {
  const h = new Bun.CryptoHasher('sha256').update(key).digest('hex');
  const oct = (i: number) => h.slice(i * 2, i * 2 + 2);
  return `02:${oct(0)}:${oct(1)}:${oct(2)}:${oct(3)}:${oct(4)}`;
}

/** True when `child` is at or below `parent` in the filesystem tree. */
function isUnder(child: string, parent: string): boolean {
  const p = parent.endsWith('/') ? parent : `${parent}/`;
  return child === parent || child.startsWith(p);
}

function mountsFor(policy: SandboxPolicy): MountSpec[] {
  // A readDenyRoot nested under an allowed (writable/readable) root would be exposed anyway: virtio-fs
  // mounts the whole subtree, and this backend has no way to subtract a denied subpath (unlike
  // Seatbelt's deny-over-allow). Rather than silently leak the secret while advertising
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
  return mounts;
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
let baseImagePromise: Promise<string> | null = null;
function ensureBaseImageOnce(): Promise<string> {
  if (baseImage) return Promise.resolve(baseImage);
  if (!baseImagePromise) {
    baseImagePromise = ensureBaseImage(config.imageConsent).then((path) => {
      baseImage = path;
      return path;
    });
  }
  return baseImagePromise;
}

async function bootVm(key: string, policy: SandboxPolicy): Promise<RunningVm> {
  const image = await ensureBaseImageOnce();
  const bundle = await ensureBundle(key, image);
  const mounts = mountsFor(policy);
  const egress = egressFor(policy);
  const proxyEnv = egress.mode === 'filtered' && egress.proxyPort ? guestProxyEnv(egress.proxyPort) : undefined;

  // Ignition: inject the one-shot pubkey, the mounts, the egress firewall.
  const pubKey = (await Bun.file(bundle.sshPubKey).text()).trim();
  const ignition = serializeIgnition({ sshPublicKey: pubKey, mounts, egress, env: proxyEnv });
  await Bun.write(bundle.ignition, ignition);

  // gvproxy carries the host-initiated SSH control plane for every egress mode. Guest nftables
  // enforces net:none/filtered independently, so retaining this NIC does not grant new outbound
  // connections.
  if (!resolvedGvproxy) throw new VmBackendNotReadyError('gvproxy not resolved (call prepare())');
  const gvproxy = spawnGvproxy({
    gvproxyBin: resolvedGvproxy,
    vfkitNetSock: bundle.gvproxySock,
    sshForwardSock: bundle.sshSock
  });
  let vfkit: VmHandle | undefined;
  try {
    await waitForSocket(bundle.gvproxySock, 5000);
    vfkit = await vfkitDriver.boot({
      cpus: config.cpus,
      memoryMiB: config.memoryMiB,
      bundle,
      mounts,
      gvproxyNetSock: bundle.gvproxySock,
      mac: macFor(key)
    });
    await waitForSsh({ sshSock: bundle.sshSock, identity: bundle.sshKey, user: 'monad' });
    const vm: RunningVm = { bundle, vfkit, gvproxy };
    liveVms.add(vm);
    return vm;
  } catch (error) {
    await vfkit?.stop().catch(() => {});
    gvproxy.kill();
    await destroyBundle(bundle.key).catch(() => {});
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
  platforms: ['darwin'],
  enforces: { writeConfine: true, readDeny: true, net: ['none', 'filtered', 'unrestricted'] },
  isAvailable: () => vmToolchainMaybeAvailable(),

  async prepare(): Promise<void> {
    // Resolve the host tooling (small: detect or download vfkit+gvproxy). The base image is pulled
    // lazily on first spawn — never block daemon boot on a multi-GB download.
    const tools = await resolveVmToolchain();
    configureVfkitBin(tools.vfkit);
    resolvedGvproxy = tools.gvproxy;
    pool = new VmPool<RunningVm>(config, { stop: stopVm });
    installShutdownHandler();
  },

  spawn(argv: string[], options: SandboxSpawnOptions, policy: SandboxPolicy): SandboxProcess {
    if (!pool) throw new VmBackendNotReadyError('not prepared — prepare() must run before spawn()');
    const key = vmKey(config.scope, options.sessionId, options.agentId, policy);
    const reuse = reuseKey(config.scope, options.sessionId, options.agentId);
    // acquire() is async (boot); the SandboxProcess must be returned synchronously, so we return a
    // proxy whose streams are fed once the VM is up and the ssh channel opens. The policy is captured
    // in the boot thunk (no module-level side table to leak).
    return bridgeAsyncExec(key, reuse, options, argv, policy);
  },

  async disposeSession(sessionId: string): Promise<void> {
    await pool?.disposeSession(sessionId);
  },

  async disposeAgent(agentId: string): Promise<void> {
    await pool?.disposeAgent(agentId);
  }
};

/** Bridge the async VM acquire + ssh exec onto a synchronous SandboxProcess. Streams are wired when
 *  the underlying ssh child starts; exited resolves with its exit code; the pool refcount is released
 *  when the run finishes. */
function bridgeAsyncExec(
  key: string,
  reuse: string,
  options: SandboxSpawnOptions,
  argv: string[],
  policy: SandboxPolicy
): SandboxProcess {
  return bridgeAsyncProcess(
    async () => {
      if (!pool) throw new VmBackendNotReadyError('not prepared');
      const vm = await pool.acquire(key, reuse, options.agentId, () => bootVm(key, policy));
      const egress = egressFor(policy);
      return sshExec(argv, {
        sshSock: vm.bundle.sshSock,
        identity: vm.bundle.sshKey,
        user: 'monad',
        cwd: options.cwd,
        env: {
          ...options.env,
          ...(egress.mode === 'filtered' && egress.proxyPort ? guestProxyEnv(egress.proxyPort) : {})
        }
      });
    },
    () => pool?.release(key)
  );
}

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
