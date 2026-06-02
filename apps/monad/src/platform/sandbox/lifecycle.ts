import type { MonadPaths } from '@monad/environment';
import type { ConfigAccess, ConfigSnapshot } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { emptyAuth } from '@monad/environment';
import { configureProtectedCredentialResolver, configureProtectedExecutionTls } from '@monad/sandbox';

import { createSandbox, resolveProtectedCredentialResolution } from './service.ts';

export interface SandboxLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  config?: () => Pick<ConfigAccess, 'get' | 'subscribe'>;
}

export function createSandboxLifecycleModule(
  options: SandboxLifecycleOptions,
  start: typeof createSandbox = createSandbox
): RuntimeModule<ConfigSnapshot> {
  let unsubscribe: (() => void) | undefined;
  const clearProtectedExecution = (): void => {
    unsubscribe?.();
    unsubscribe = undefined;
    configureProtectedCredentialResolver(undefined);
    configureProtectedExecutionTls(false);
  };
  return {
    id: 'platform.sandbox',
    criticality: 'required',
    requires: ['store'],
    start: async (context) => {
      clearProtectedExecution();
      const layer = context.get<DataLayer>('store');
      const config = options.config?.();
      const current = config?.get() ?? options.initial;
      try {
        const setup = await start(current.cfg, options.paths, layer.store, current.auth ?? undefined);
        configureProtectedCredentialResolver(async (agentId) => {
          const snapshot = config?.get() ?? current;
          return resolveProtectedCredentialResolution(
            { cfg: snapshot.cfg, auth: snapshot.auth ?? emptyAuth() },
            agentId
          );
        });
        unsubscribe = config?.subscribe(
          (snapshot) => snapshot.cfg.sandbox.tlsTerminate.enabled,
          (enabled) => configureProtectedExecutionTls(enabled)
        );
        configureProtectedExecutionTls((config?.get() ?? current).cfg.sandbox.tlsTerminate.enabled);
        return setup;
      } catch (error) {
        clearProtectedExecution();
        throw error;
      }
    },
    stop: () => clearProtectedExecution()
  };
}
