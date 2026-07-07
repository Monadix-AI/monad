import type { ExternalAgentHostDeps } from '@/services/external-agent/host/host-types.ts';

import { daemonChildProcesses } from '@/infra/daemon-child-processes.ts';
import { cleanupManagedProjectOrphanTokens } from '@/services/external-agent/managed-project.ts';
import {
  killExternalAgentProcess,
  readProcessRegistry,
  writeProcessRegistry
} from '@/services/external-agent/process.ts';

export interface ExternalAgentProcessLifecycleContext {
  store: ExternalAgentHostDeps['store'];
  monadHome: ExternalAgentHostDeps['monadHome'];
  externalAgentProcessRegistryPath: ExternalAgentHostDeps['externalAgentProcessRegistryPath'];
  authProcessRegistryPath: ExternalAgentHostDeps['authProcessRegistryPath'];
}

/** Tracks daemon-owned external agent child processes so they can be reaped on restart: mirrors every
 *  spawned/exited pid into both the in-process daemon-child-process registry and a durable on-disk
 *  registry file, and reconciles orphans left behind by a previous, uncleanly-stopped daemon. */
export class ExternalAgentProcessLifecycle {
  /** Serializes read-modify-write access to the external agent process registry file: the reads/writes
   *  are async (never block the event loop), so overlapping track/untrack calls are chained onto
   *  this promise instead of racing each other and losing an update. */
  private registryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: ExternalAgentProcessLifecycleContext) {}

  /** Returns the queued registry write so a caller on the critical start/stop path can await
   *  durability before reporting success (e.g. over HTTP) — callers that don't care can ignore it,
   *  since the queue always keeps draining regardless. */
  track(pid: number): Promise<void> {
    daemonChildProcesses.track(pid, 'external-agent', () => killExternalAgentProcess(pid));
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.ctx.externalAgentProcessRegistryPath))
      .then((pids) => writeProcessRegistry(this.ctx.externalAgentProcessRegistryPath, [...new Set([...pids, pid])]))
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  untrack(pid: number): Promise<void> {
    daemonChildProcesses.untrack(pid);
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.ctx.externalAgentProcessRegistryPath))
      .then((pids) =>
        writeProcessRegistry(
          this.ctx.externalAgentProcessRegistryPath,
          pids.filter((candidate) => candidate !== pid)
        )
      )
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  async reconcileOrphanedSessions(): Promise<number> {
    const native = this.ctx.store.reconcileOrphanedExternalAgentSessions((pid) => killExternalAgentProcess(pid));
    const orphanedTokens = this.ctx.monadHome ? cleanupManagedProjectOrphanTokens(this.ctx.monadHome) : 0;
    const orphanedNative = await readProcessRegistry(this.ctx.externalAgentProcessRegistryPath);
    for (const pid of orphanedNative) killExternalAgentProcess(pid);
    await writeProcessRegistry(this.ctx.externalAgentProcessRegistryPath, []);
    const auth = await readProcessRegistry(this.ctx.authProcessRegistryPath);
    for (const pid of auth) killExternalAgentProcess(pid);
    await writeProcessRegistry(this.ctx.authProcessRegistryPath, []);
    return native + orphanedTokens + orphanedNative.length + auth.length;
  }
}
