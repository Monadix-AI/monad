import type { MonadConfig } from '@monad/environment';
import type { MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { monadMeshAgentAdapter } from '../../../../packages/atoms/src/agent-adapters/monad/index.ts';
import { createMeshAgentSettingsModule } from '../../src/handlers/settings/mesh-agent/index.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '../../src/services/mesh-agent/index.ts';

test('saving Monad Autopilot remains enabled when settings are listed again', async () => {
  registerAgentAdapterImpl(monadMeshAgentAdapter);
  let cfg = {
    agent: { agents: [] },
    meshAgents: [
      {
        name: 'monad',
        provider: 'monad',
        command: 'monad',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  } as unknown as MonadConfig;
  try {
    const settings = createMeshAgentSettingsModule({
      config: {
        get: () => ({ cfg, auth: null }),
        updateConfig: async (
          mutate: (value: MonadConfig) => MonadConfig | undefined | Promise<MonadConfig | undefined>
        ) => {
          cfg = (await mutate(structuredClone(cfg))) ?? cfg;
          return { cfg, auth: null };
        }
      } as never,
      presetFallbacks: () => [],
      syncDiscoveredAgents: async (input) => ({ cfg: input, changed: false })
    });
    const agent: MeshAgentView = {
      name: 'monad',
      provider: 'monad',
      productIcon: 'monad',
      command: 'monad',
      enabled: true,
      allowAutopilot: true,
      approvalOwnership: 'provider-owned'
    };

    await settings.upsertMeshAgent({ agent });
    const reopened = await settings.listMeshAgents();

    expect({
      persisted: cfg.meshAgents.map((entry) => ({ name: entry.name, allowAutopilot: entry.allowAutopilot })),
      reopened: reopened.agents.map((entry) => ({
        name: entry.name,
        allowAutopilot: entry.allowAutopilot,
        supportsAutopilot: entry.capabilities?.autopilot
      }))
    }).toEqual({
      persisted: [{ name: 'monad', allowAutopilot: true }],
      reopened: [{ name: 'monad', allowAutopilot: true, supportsAutopilot: true }]
    });
  } finally {
    unregisterAgentAdapterImpl('monad');
  }
});
