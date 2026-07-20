export interface DaemonShutdownDependencies {
  schedule: { dispose(): void };
  watchers: { closeAll(): void };
  channels: { stop(): Promise<void> };
  meshAgents: { stopAll(): void };
  runtime: { stop(): Promise<void> };
}

export function createDaemonShutdown(dependencies: DaemonShutdownDependencies): () => Promise<void> {
  let stopping: Promise<void> | undefined;

  return () => {
    stopping ??= (async () => {
      dependencies.schedule.dispose();
      dependencies.watchers.closeAll();
      await dependencies.channels.stop();
      // Persists each live mesh session's exit state, so it must run before the store lifecycle
      // module (owned by `runtime.stop()` below) closes its DB connection.
      dependencies.meshAgents.stopAll();
      await dependencies.runtime.stop();
    })();
    return stopping;
  };
}
