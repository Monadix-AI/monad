import type { MonadPaths } from '@monad/environment';
import type { ConfigAccess } from '#/config/manager.ts';

import { createAgentContext } from './context.ts';
import { createAgentHandlers } from './handlers.ts';

export interface AgentModuleDeps {
  paths: MonadPaths;
  config: ConfigAccess;
}

export function createAgentModule(deps: AgentModuleDeps) {
  const ctx = createAgentContext({ paths: deps.paths, config: deps.config });
  return createAgentHandlers(ctx);
}
