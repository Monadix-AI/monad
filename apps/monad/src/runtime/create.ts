import type { ReloadScheduler } from '#/config/reload.ts';
import type { ConfigSnapshot, ConfigSource } from '#/config/service.ts';
import type { RuntimeModule } from './types.ts';

import { ConfigService } from '#/config/service.ts';
import { RuntimeKernel } from './kernel.ts';

export interface DaemonRuntimeOptions {
  initial: ConfigSnapshot;
  modules: readonly RuntimeModule<ConfigSnapshot>[];
  source: ConfigSource;
  debounceMs?: number;
  equals?: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  onConfigError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
}

export interface DaemonRuntime {
  readonly config: ConfigService;
  readonly kernel: RuntimeKernel<ConfigSnapshot>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  const kernel = new RuntimeKernel<ConfigSnapshot>(options.modules);
  const config = new ConfigService({
    initial: options.initial,
    source: options.source,
    apply: async (snapshot) => {
      await kernel.reload(snapshot);
    },
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.equals === undefined ? {} : { equals: options.equals }),
    ...(options.onConfigError === undefined ? {} : { onError: options.onConfigError }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler })
  });

  return {
    config,
    kernel,
    async start() {
      await kernel.start();
      try {
        config.startWatching();
      } catch (error) {
        await kernel.stop();
        throw error;
      }
    },
    async stop() {
      try {
        await config.stop();
      } finally {
        await kernel.stop();
      }
    }
  };
}
