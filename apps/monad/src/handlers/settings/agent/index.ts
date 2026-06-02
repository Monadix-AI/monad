import type { MonadPaths } from '@monad/home';
import type { PrincipalId } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { createAgentContext } from './context.ts';
import { createAgentHandlers } from './handlers.ts';

export interface AgentModuleDeps {
  paths: MonadPaths;
  ownerPrincipalId: PrincipalId;
  configBus?: ConfigBus;
}

export function createAgentModule(deps: AgentModuleDeps) {
  const ctx = createAgentContext({ paths: deps.paths, configBus: deps.configBus });
  return createAgentHandlers(ctx, deps.ownerPrincipalId);
}
