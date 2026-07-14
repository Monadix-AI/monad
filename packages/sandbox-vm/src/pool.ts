// The VM lifecycle state machine. One VM per reuse key (`agentId ?? sessionId`), reused across a
// key's sessions. A VM is keyed on (reuseKey, policyFingerprint): a run whose policy differs from the
// running VM's shape (different net mode, different mounts) must NOT reuse it — it gets its own VM.
//
//   none ──(first run)──▶ Booting ──▶ Running ──(refcount→0)──▶ Idle ──(TTL | LRU | dispose)──▶ stopped
//
// Reference counting is pool-local: there is no agent→sessions index in the store, so the pool tracks
// active runs itself (+1 on acquire, −1 on release). Destroying a VM on agent-config change is a
// security constraint (a stale VM must not outlive the policy it was built for), surfaced via
// disposeAgent().

import type { SandboxPolicy } from '@monad/sdk-atom';

export type VmScope = 'agent' | 'session';

export interface PoolConfig {
  scope: VmScope;
  idleTtlMs: number;
  /** Max concurrent VMs; over the limit the least-recently-used idle VM is evicted. */
  maxInstances: number;
}

export const POOL_DEFAULTS: PoolConfig = {
  scope: 'agent',
  idleTtlMs: 10 * 60 * 1000,
  maxInstances: 8
};

export interface EffectiveVmIdentityInputs {
  agentDigest: string;
  baseImageDigest: string;
  cpus: number;
  ignitionSchemaVersion: string;
  memoryMiB: number;
  mountPlanDigest: string;
  mountPlanSchemaVersion: number;
  observerDigest: string;
  protocolVersion: number;
  workloadUid: number;
  runIsolation: {
    memoryMiB: number;
    maxProcesses: number;
    terminateGraceMs: number;
  };
  vsockPort: number;
}

export interface EffectiveVmIdentity extends EffectiveVmIdentityInputs {
  policy: {
    credentialGeneration: number | null;
    maskedFiles: { real: string; fake: string }[] | null;
    net: 'default' | 'none' | 'unrestricted' | { allowProxyPort: number };
    readDenyRoots: string[] | null;
    readableRoots: string[] | null;
    writableRoots: string[] | null;
  };
}

function canonicalPaths(paths: string[] | undefined): string[] | null {
  return paths === undefined ? null : [...paths].sort();
}

export function effectiveVmIdentity(policy: SandboxPolicy, inputs: EffectiveVmIdentityInputs): EffectiveVmIdentity {
  const maskedFiles =
    policy.maskedFiles === undefined
      ? null
      : [...policy.maskedFiles].sort((a, b) => a.real.localeCompare(b.real) || a.fake.localeCompare(b.fake));
  const net =
    policy.net === undefined
      ? 'default'
      : typeof policy.net === 'object'
        ? { allowProxyPort: policy.net.allowProxyPort }
        : policy.net;
  return {
    ...inputs,
    policy: {
      credentialGeneration: policy.credentialGeneration ?? null,
      maskedFiles,
      net,
      readDenyRoots: canonicalPaths(policy.readDenyRoots),
      readableRoots: canonicalPaths(policy.readableRoots),
      writableRoots: canonicalPaths(policy.writableRoots)
    }
  };
}

export function policyFingerprint(identity: EffectiveVmIdentity): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(JSON.stringify(identity));
  return hasher.digest('hex').slice(0, 16);
}

/** The reuse key: the agent (per-agent scope) or the session (per-session scope, or no bound agent). */
export function reuseKey(scope: VmScope, sessionId: string | undefined, agentId: string | undefined): string {
  if (scope === 'agent' && agentId) return `agt:${agentId}`;
  return `ses:${sessionId ?? 'anon'}`;
}

export function vmKey(
  scope: VmScope,
  sessionId: string | undefined,
  agentId: string | undefined,
  identity: EffectiveVmIdentity
): string {
  return `${reuseKey(scope, sessionId, agentId)}#${policyFingerprint(identity)}`;
}

type VmState = 'booting' | 'running' | 'idle' | 'stopped';

interface Entry<VM> {
  key: string;
  reuseKey: string;
  agentId?: string;
  vm: Promise<VM>;
  state: VmState;
  refcount: number;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface PoolHooks<VM> {
  /** Tear a VM down (kill vfkit + gvproxy, remove the bundle). */
  stop(vm: VM): Promise<void>;
  /** Monotonic clock; injectable for tests. */
  now?(): number;
}

/** Generic VM pool: acquire/release with refcount, idle-TTL teardown, LRU eviction, and agent dispose.
 *  The launcher supplies boot/stop; the pool owns the state machine. */
export class VmPool<VM> {
  private readonly entries = new Map<string, Entry<VM>>();
  private readonly now: () => number;

  constructor(
    private readonly config: PoolConfig,
    private readonly hooks: PoolHooks<VM>
  ) {
    this.now = hooks.now ?? (() => Date.now());
  }

  /** Get (or boot) the VM for this key and increment its refcount. `boot` is a per-call thunk (it
   *  captures the run's policy), invoked only on a fresh key. Caller MUST release() when done. */
  async acquire(key: string, reuse: string, agentId: string | undefined, boot: () => Promise<VM>): Promise<VM> {
    let entry = this.entries.get(key);
    if (!entry) {
      await this.evictIfOverCapacity();
      entry = {
        key,
        reuseKey: reuse,
        agentId,
        vm: boot(),
        state: 'booting',
        refcount: 0,
        lastUsed: this.now()
      };
      this.entries.set(key, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.refcount++;
    entry.lastUsed = this.now();
    try {
      const vm = await entry.vm;
      if (this.entries.get(key) !== entry || entry.state === 'stopped') {
        throw new Error(`vm pool: ${key} was invalidated while being acquired`);
      }
      entry.state = 'running';
      return vm;
    } catch (err) {
      // A rejected boot must NOT stay cached: otherwise every later acquire on this key re-awaits the
      // same rejected promise (and each release() pushes teardown out another idleTtlMs), wedging the
      // key. Drop the entry so the next acquire boots fresh.
      entry.refcount = Math.max(0, entry.refcount - 1);
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw err;
    }
  }

  /** Decrement refcount; at zero the VM enters Idle and is torn down after idleTtlMs. */
  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refcount = Math.max(0, entry.refcount - 1);
    entry.lastUsed = this.now();
    if (entry.refcount === 0) {
      entry.state = 'idle';
      entry.idleTimer = setTimeout(() => void this.teardown(key), this.config.idleTtlMs);
      // Don't keep the process alive just for the idle timer.
      (entry.idleTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Destroy every VM whose reuse key belongs to this agent — the security dispose. */
  async disposeAgent(agentId: string): Promise<void> {
    const target = `agt:${agentId}`;
    const keys = [...this.entries.values()].filter((e) => e.reuseKey === target).map((e) => e.key);
    await Promise.all(keys.map((k) => this.teardown(k)));
  }

  /** Destroy every VM whose reuse key is this session (per-session scope, or no bound agent). */
  async disposeSession(sessionId: string): Promise<void> {
    const target = `ses:${sessionId}`;
    const keys = [...this.entries.values()].filter((e) => e.reuseKey === target).map((e) => e.key);
    await Promise.all(keys.map((k) => this.teardown(k)));
  }

  /** Tear down only idle VMs when switching away; running processes retain ownership of their VM. */
  async disposeIdle(): Promise<void> {
    const keys = [...this.entries.values()].filter((entry) => entry.refcount === 0).map((entry) => entry.key);
    await Promise.all(keys.map((key) => this.teardown(key)));
  }

  async invalidate(key: string): Promise<void> {
    await this.teardown(key);
  }

  /** Tear down all VMs (daemon shutdown). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((k) => this.teardown(k)));
  }

  private async teardown(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.state = 'stopped';
    try {
      await this.hooks.stop(await entry.vm);
    } catch {
      /* best-effort teardown */
    }
  }

  /** When at capacity, evict the least-recently-used IDLE VM. If none is idle, throw — the operator
   *  set the cap and every VM is busy; silently killing an active VM would corrupt a running task. */
  private async evictIfOverCapacity(): Promise<void> {
    if (this.entries.size < this.config.maxInstances) return;
    const idle = [...this.entries.values()].filter((e) => e.state === 'idle').sort((a, b) => a.lastUsed - b.lastUsed);
    const lru = idle[0];
    if (!lru) {
      throw new Error(
        `vm pool: at capacity (${this.config.maxInstances} VMs, all busy) — raise sandbox.vm.maxInstances or wait`
      );
    }
    await this.teardown(lru.key);
  }

  /** Test/inspection: current VM count. */
  size(): number {
    return this.entries.size;
  }
}
