import type { MonadPaths } from '@monad/environment';
import type { ConfigSnapshot } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { createSandbox } from './service.ts';

export interface SandboxLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
}

export function createSandboxLifecycleModule(
  options: SandboxLifecycleOptions,
  start: typeof createSandbox = createSandbox
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'platform.sandbox',
    criticality: 'required',
    requires: ['store'],
    start: (context) => {
      const layer = context.get<DataLayer>('store');
      return start(options.initial.cfg, options.paths, layer.store, options.initial.auth ?? undefined);
    }
  };
}
