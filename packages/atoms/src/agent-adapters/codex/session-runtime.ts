import type { MeshAgentView } from '@monad/protocol';
import type { MeshAgentSessionRuntimeContext, SessionEventRuntimeDefinition } from '@monad/sdk-atom';

import { CodexAppServerDriver } from './app-server/driver.ts';
import { buildCodexSessionLaunch } from './launch.ts';

export const CODEX_APP_SERVER_IDLE_TIMEOUT_MS = 300_000;

export function createCodexSessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const launch = buildCodexSessionLaunch(
    {
      ...agent,
      ...(context.env || agent.env ? { env: { ...(agent.env ?? {}), ...(context.env ?? {}) } } : {})
    },
    {
      workingPath: context.workingPath,
      extraWorkingPaths: context.extraWorkingPaths,
      skipProviderApprovals: context.skipProviderApprovals,
      speed: context.speed,
      mcpConfigArgs: context.mcpConfigArgs
    }
  );
  return {
    plan: {
      processModel: 'resident',
      launch,
      channel: { kind: 'child-stdio' },
      startup: { timeoutMs: 20_000 },
      suspend: { idleTimeoutMs: CODEX_APP_SERVER_IDLE_TIMEOUT_MS }
    },
    driver: new CodexAppServerDriver(context)
  };
}
