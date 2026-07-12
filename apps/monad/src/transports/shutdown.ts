export interface DaemonShutdownDependencies {
  schedule: { dispose(): void };
  watchers: { closeAll(): void };
  channels: { stop(): Promise<void> };
  runtime: { stop(): Promise<void> };
}

export function createDaemonShutdown(dependencies: DaemonShutdownDependencies): () => Promise<void> {
  let stopping: Promise<void> | undefined;

  return () => {
    stopping ??= (async () => {
      dependencies.schedule.dispose();
      dependencies.watchers.closeAll();
      await dependencies.channels.stop();
      await dependencies.runtime.stop();
    })();
    return stopping;
  };
}
