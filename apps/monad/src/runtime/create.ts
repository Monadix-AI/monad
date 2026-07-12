import type { MonadPaths } from '@monad/home';
import type { SkillWatchRegistrar } from '#/capabilities/skills/service.ts';
import type { ReloadScheduler } from '#/config/reload.ts';
import type { ConfigSnapshot, ConfigSource } from '#/config/service.ts';
import type { RuntimeModule } from './types.ts';

import { createModelLifecycleModule } from '#/agent/model/lifecycle.ts';
import { createAtomsLifecycleModule } from '#/atoms/lifecycle.ts';
import { createCapabilitiesLifecycleModule } from '#/capabilities/lifecycle.ts';
import { createMcpLifecycleModule } from '#/capabilities/mcp/lifecycle.ts';
import { createSkillsLifecycleModule } from '#/capabilities/skills/lifecycle.ts';
import { ConfigService } from '#/config/service.ts';
import { createSandboxLifecycleModule } from '#/platform/sandbox/lifecycle.ts';
import { createStoreLifecycleModule, type StartDataLayer } from '#/store/lifecycle.ts';
import { RuntimeKernel } from './kernel.ts';

export interface DaemonModulesOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  devMode: boolean;
  useMock: boolean;
  monadVersion: string;
  watcher: SkillWatchRegistrar;
  logger: { warn(message: string): void };
  startStore?: StartDataLayer;
}

export function createDaemonModules(options: DaemonModulesOptions): RuntimeModule<ConfigSnapshot>[] {
  return [
    options.startStore === undefined
      ? createStoreLifecycleModule({ paths: options.paths, devMode: options.devMode })
      : createStoreLifecycleModule({ paths: options.paths, devMode: options.devMode }, options.startStore),
    createSandboxLifecycleModule({ initial: options.initial, paths: options.paths }),
    createModelLifecycleModule({ initial: options.initial, paths: options.paths, useMock: options.useMock }),
    createCapabilitiesLifecycleModule({ paths: options.paths }),
    createAtomsLifecycleModule({ initial: options.initial, paths: options.paths, logger: options.logger }),
    createSkillsLifecycleModule({
      initial: options.initial,
      paths: options.paths,
      monadVersion: options.monadVersion,
      watcher: options.watcher
    }),
    createMcpLifecycleModule({ initial: options.initial, paths: options.paths })
  ];
}

export interface DaemonRuntimeOptions {
  initial: ConfigSnapshot;
  modules: readonly RuntimeModule<ConfigSnapshot>[];
  source: ConfigSource;
  debounceMs?: number;
  equals?: (a: ConfigSnapshot, b: ConfigSnapshot) => boolean;
  onConfigError?: (error: unknown) => void;
  scheduler?: ReloadScheduler;
  afterReload?: (snapshot: ConfigSnapshot) => Promise<void>;
  watchOnStart?: boolean;
}

export interface DaemonRuntime {
  readonly config: ConfigService;
  readonly kernel: RuntimeKernel<ConfigSnapshot>;
  start(): Promise<void>;
  startWatching(): void;
  stop(): Promise<void>;
}

export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  const kernel = new RuntimeKernel<ConfigSnapshot>(options.modules);
  const config = new ConfigService({
    initial: options.initial,
    source: options.source,
    apply: async (snapshot) => {
      await kernel.reload(snapshot);
      await options.afterReload?.(snapshot);
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
      if (options.watchOnStart === false) return;
      try {
        config.startWatching();
      } catch (error) {
        await kernel.stop();
        throw error;
      }
    },
    startWatching() {
      config.startWatching();
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
