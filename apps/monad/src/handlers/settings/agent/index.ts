import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';

import { createAgentContext } from './context.ts';
import { createAgentHandlers } from './handlers.ts';

export interface AgentModuleDeps {
  paths: MonadPaths;
  ownerPrincipalId: PrincipalId;
  configReloader?: ConfigReloader;
}

export function createAgentModule(deps: AgentModuleDeps) {
  const ctx = createAgentContext({ paths: deps.paths, configReloader: deps.configReloader });
  return createAgentHandlers(ctx, deps.ownerPrincipalId);
}
