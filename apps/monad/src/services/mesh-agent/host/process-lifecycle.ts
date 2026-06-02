import type { MeshAgentHostDeps } from '#/services/mesh-agent/host/host-types.ts';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import { cleanupManagedProjectOrphanTokens } from '#/services/mesh-agent/managed-project.ts';
import { killMeshAgentProcess, readProcessRegistry, writeProcessRegistry } from '#/services/mesh-agent/process.ts';

interface MeshAgentProcessLifecycleContext {
  store: MeshAgentHostDeps['store'];
  monadHome: MeshAgentHostDeps['monadHome'];
  meshAgentProcessRegistryPath: MeshAgentHostDeps['meshAgentProcessRegistryPath'];
  authProcessRegistryPath: MeshAgentHostDeps['authProcessRegistryPath'];
}

/** Tracks daemon-owned MeshAgent child processes so they can be reaped on restart: mirrors every
 *  spawned/exited pid into both the in-process daemon-child-process registry and a durable on-disk
 *  registry file, and reconciles orphans left behind by a previous, uncleanly-stopped daemon. */
export class MeshAgentProcessLifecycle {
  /** Serializes read-modify-write access to the MeshAgent process registry file: the reads/writes
   *  are async (never block the event loop), so overlapping track/untrack calls are chained onto
   *  this promise instead of racing each other and losing an update. */
  private registryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: MeshAgentProcessLifecycleContext) {}

  /** Returns the queued registry write so a caller on the critical start/stop path can await
   *  durability before reporting success (e.g. over HTTP) — callers that don't care can ignore it,
   *  since the queue always keeps draining regardless. */
  track(pid: number): Promise<void> {
    daemonChildProcesses.track(pid, 'mesh-agent', () => killMeshAgentProcess(pid));
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.ctx.meshAgentProcessRegistryPath))
      .then((pids) => writeProcessRegistry(this.ctx.meshAgentProcessRegistryPath, [...new Set([...pids, pid])]))
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  untrack(pid: number): Promise<void> {
    daemonChildProcesses.untrack(pid);
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.ctx.meshAgentProcessRegistryPath))
      .then((pids) =>
        writeProcessRegistry(
          this.ctx.meshAgentProcessRegistryPath,
          pids.filter((candidate) => candidate !== pid)
        )
      )
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  async reconcileOrphanedSessions(): Promise<number> {
    const native = this.ctx.store.reconcileOrphanedMeshSessions((pid) => killMeshAgentProcess(pid));
    const orphanedTokens = this.ctx.monadHome ? cleanupManagedProjectOrphanTokens(this.ctx.monadHome) : 0;
    const orphanedNative = await readProcessRegistry(this.ctx.meshAgentProcessRegistryPath);
    for (const pid of orphanedNative) killMeshAgentProcess(pid);
    await writeProcessRegistry(this.ctx.meshAgentProcessRegistryPath, []);
    const auth = await readProcessRegistry(this.ctx.authProcessRegistryPath);
    for (const pid of auth) killMeshAgentProcess(pid);
    await writeProcessRegistry(this.ctx.authProcessRegistryPath, []);
    return native + orphanedTokens + orphanedNative.length + auth.length;
  }
}
