// @monad/sandbox-vm — the macOS VM sandbox backend. A heavy launcher (like docker/e2b) registered
// through @monad/monad-power-pack; selected only when config.sandbox.backend = 'vm'. Unlike the light
// OS launchers it does not wrap() argv — it runs each command inside a per-agent Fedora CoreOS VM
// (own kernel, own filesystem, own process table) over ssh, and returns a SandboxProcess the daemon's
// seam bridges onto its callers.
//
// Isolation model, per SandboxPolicy:
//   • writableRoots / readableRoots → virtio-fs mounts at the same guest paths (argv unchanged);
//     readDenyRoots simply aren't mounted (they don't exist in the guest).
//   • the guest always has a NIC (the exec channel is ssh over gvproxy); egress is enforced by an
//     in-guest nftables ruleset — net:'none' drops all new outbound, net:'filtered' allows only the
//     host egress proxy, net:'unrestricted' adds no rules. The agent (unprivileged) can't alter it.
//
// Reuse is per-agent (one VM across an agent's sessions); see pool.ts for the lifecycle state machine.

import type { SandboxLauncher, SandboxPolicy, SandboxProcess, SandboxSpawnOptions } from '@monad/sdk-atom';
import type { MountSpec } from './ignition.ts';

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { destroyBundle, ensureBundle, type VmBundle } from './bundle.ts';
import { configureVfkitBin, type VmHandle, vfkitDriver } from './driver/vfkit.ts';
import { bridgeAsyncProcess, sshExec, waitForSsh } from './exec/ssh.ts';
import { serializeIgnition } from './ignition.ts';
import { ensureBaseImage, type ImageConsent } from './image.ts';
import { type GvproxyProcess, guestProxyEnv, spawnGvproxy } from './net/gvproxy.ts';
import { POOL_DEFAULTS, type PoolConfig, reuseKey, VmPool, vmKey } from './pool.ts';
import { resolveVmToolchain, vmToolchainMaybeAvailable } from './toolchain.ts';
import { freePort } from './util.ts';

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
  /** How long to wait for a freshly-booted guest to become ssh-reachable (CoreOS boot + Ignition). */
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
  gvproxy: GvproxyProcess;
  /** Host loopback port gvproxy forwards to the guest sshd (the exec channel ssh's here). */
  sshHostPort: number;
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

  // gvproxy + the NIC are ALWAYS present: the exec channel is ssh over gvproxy's forward-sock, so the
  // guest needs a NIC even for net:'none' (egress is blocked by the guest firewall, not by removing
  // the NIC — see guestNftables). Start gvproxy first and WAIT for it to bind its datagram socket
  // before booting vfkit — vfkit's virtio-net attaches to that socket path at boot, so a race where
  // vfkit starts first leaves the guest with no network.
  if (!resolvedGvproxy) throw new VmBackendNotReadyError('gvproxy not resolved (call prepare())');
  // gvproxy fatally exits if its listen socket path already exists (a stale socket from a prior boot
  // of a reused bundle), so clear it first.
  await rm(bundle.gvproxySock, { force: true });
  const sshHostPort = await freePort();
  const gvproxy = spawnGvproxy({
    gvproxyBin: resolvedGvproxy,
    vfkitNetSock: bundle.gvproxySock,
    sshHostPort
  });
  await waitForSocket(bundle.gvproxySock, 5000);

  const vfkit = await vfkitDriver.boot({
    cpus: config.cpus,
    memoryMiB: config.memoryMiB,
    bundle,
    mounts,
    gvproxyNetSock: bundle.gvproxySock,
    mac: macFor(key)
  });

  const vm: RunningVm = { bundle, vfkit, gvproxy, sshHostPort };
  liveVms.add(vm);
  // vfkitDriver.boot() returns as soon as the vfkit process is spawned, NOT when the guest is up.
  // Fedora CoreOS takes ~30-60s to boot + apply Ignition + start sshd, so wait until the guest is
  // exec-reachable before returning — otherwise the first command races an unbooted guest.
  await waitForSsh({ sshHostPort, identity: bundle.sshKey, user: 'monad' }, { timeoutMs: config.bootTimeoutMs });
  return vm;
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
    // acquire() is async (boot); the SandboxProcess must be returned synchronously, so bridge the
    // async acquire + ssh exec. The policy is captured in the boot thunk (no module-level side table).
    return bridgeAsyncProcess(
      async () => {
        const vm = await pool!.acquire(key, reuse, options.agentId, () => bootVm(key, policy));
        const egress = egressFor(policy);
        return sshExec(argv, {
          sshHostPort: vm.sshHostPort,
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
  },

  async disposeSession(sessionId: string): Promise<void> {
    await pool?.disposeSession(sessionId);
  },

  async disposeAgent(agentId: string): Promise<void> {
    await pool?.disposeAgent(agentId);
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
