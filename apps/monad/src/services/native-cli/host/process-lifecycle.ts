import type { NativeCliHostDeps } from '@/services/native-cli/host/host-types.ts';

import { daemonChildProcesses } from '@/infra/daemon-child-processes.ts';
import { cleanupManagedProjectOrphanTokens } from '@/services/native-cli/managed-project.ts';
import { killNativeCliProcess, readProcessRegistry, writeProcessRegistry } from '@/services/native-cli/process.ts';

export interface NativeCliProcessLifecycleContext {
  store: NativeCliHostDeps['store'];
  monadHome: NativeCliHostDeps['monadHome'];
  nativeCliProcessRegistryPath: NativeCliHostDeps['nativeCliProcessRegistryPath'];
  authProcessRegistryPath: NativeCliHostDeps['authProcessRegistryPath'];
}

/** Tracks daemon-owned native-CLI child processes so they can be reaped on restart: mirrors every
 *  spawned/exited pid into both the in-process daemon-child-process registry and a durable on-disk
 *  registry file, and reconciles orphans left behind by a previous, uncleanly-stopped daemon. */
export class NativeCliProcessLifecycle {
  /** Serializes read-modify-write access to the native-CLI process registry file: the reads/writes
   *  are async (never block the event loop), so overlapping track/untrack calls are chained onto
   *  this promise instead of racing each other and losing an update. */
  private registryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: NativeCliProcessLifecycleContext) {}

  /** Returns the queued registry write so a caller on the critical start/stop path can await
   *  durability before reporting success (e.g. over HTTP) — callers that don't care can ignore it,
   *  since the queue always keeps draining regardless. */
  track(pid: number): Promise<void> {
    daemonChildProcesses.track(pid, 'native-cli', () => killNativeCliProcess(pid));
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.ctx.nativeCliProcessRegistryPath))
      .then((pids) => writeProcessRegistry(this.ctx.nativeCliProcessRegistryPath, [...new Set([...pids, pid])]))
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  untrack(pid: number): Promise<void> {
    daemonChildProcesses.untrack(pid);
    this.registryQueue = this.registryQueue
      .then(() => readProcessRegistry(this.ctx.nativeCliProcessRegistryPath))
      .then((pids) =>
        writeProcessRegistry(
          this.ctx.nativeCliProcessRegistryPath,
          pids.filter((candidate) => candidate !== pid)
        )
      )
      .catch(() => {
        /* best-effort registry write — never blocks or breaks the queue for later calls */
      });
    return this.registryQueue;
  }

  async reconcileOrphanedSessions(): Promise<number> {
    const native = this.ctx.store.reconcileOrphanedNativeCliSessions((pid) => killNativeCliProcess(pid));
    const orphanedTokens = this.ctx.monadHome ? cleanupManagedProjectOrphanTokens(this.ctx.monadHome) : 0;
    const orphanedNative = await readProcessRegistry(this.ctx.nativeCliProcessRegistryPath);
    for (const pid of orphanedNative) killNativeCliProcess(pid);
    await writeProcessRegistry(this.ctx.nativeCliProcessRegistryPath, []);
    const auth = await readProcessRegistry(this.ctx.authProcessRegistryPath);
    for (const pid of auth) killNativeCliProcess(pid);
    await writeProcessRegistry(this.ctx.authProcessRegistryPath, []);
    return native + orphanedTokens + orphanedNative.length + auth.length;
  }
}
