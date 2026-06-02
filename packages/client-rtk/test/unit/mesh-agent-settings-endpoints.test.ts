import type { MonadClient } from '@monad/client';
import type { InvitableMeshAgent, MeshAgentView } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { listInvitableMeshAgentsApi } from '../../src/endpoints/mesh-agent/list-invitable-mesh-agents.ts';
import { listMeshAgentsApi, meshAgentSelectors } from '../../src/endpoints/settings/mesh-agents/list-mesh-agents.ts';
import { refreshMeshAgentCatalogApi } from '../../src/endpoints/settings/mesh-agents/refresh-mesh-agent-catalog.ts';
import { upsertMeshAgentApi } from '../../src/endpoints/settings/mesh-agents/upsert-mesh-agent.ts';
import { createMonadStore } from '../../src/index.ts';

const gemini: MeshAgentView = {
  name: 'gemini',
  provider: 'gemini',
  command: 'gemini',
  args: [],
  enabled: true,
  allowAutopilot: true,
  approvalOwnership: 'provider-owned'
};

test('MeshAgent upsert exposes the agent only after persistence succeeds', async () => {
  let persistedAgents: MeshAgentView[] = [];
  let finishPut: (() => void) | undefined;
  const putPending = new Promise<void>((resolve) => {
    finishPut = resolve;
  });
  const agentsRoute = Object.assign(
    ({ name }: { name: string }) => ({
      put: async ({ agent }: { agent: MeshAgentView }) => {
        await putPending;
        expect(name).toBe(agent.name);
        persistedAgents = [agent];
        return { data: { ok: true }, error: null, status: 200 };
      }
    }),
    {
      get: async () => ({ data: { agents: persistedAgents }, error: null, status: 200 })
    }
  );
  const client = {
    treaty: { v1: { mesh: { agents: agentsRoute } } },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;
  const store = createMonadStore({ client });

  await store.dispatch(listMeshAgentsApi.endpoints.listMeshAgents.initiate());
  const upsert = store.dispatch(upsertMeshAgentApi.endpoints.upsertMeshAgent.initiate(gemini));
  await Promise.resolve();

  const pendingState = listMeshAgentsApi.endpoints.listMeshAgents.select()(store.getState() as never);
  expect(meshAgentSelectors.selectAll(pendingState.data ?? { ids: [], entities: {} })).toEqual([]);

  finishPut?.();
  await upsert;

  const persistedState = listMeshAgentsApi.endpoints.listMeshAgents.select()(store.getState() as never);
  expect(meshAgentSelectors.selectAll(persistedState.data ?? { ids: [], entities: {} })).toEqual([gemini]);
});

test('invitable MeshAgent endpoint returns the safe project invitation catalog', async () => {
  const monadAgent: InvitableMeshAgent = {
    name: 'monad--agt_000000000000',
    displayName: 'Reviewer',
    provider: 'monad',
    productIcon: 'monad',
    enabled: true,
    allowAutopilot: true,
    modelOptions: [],
    reasoningEfforts: [],
    source: 'monad-agent'
  };
  let requests = 0;
  const client = {
    treaty: {
      v1: {
        mesh: {
          'invitable-agents': {
            get: async () => {
              requests += 1;
              return { data: { agents: [monadAgent] }, error: null, status: 200 };
            }
          }
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;
  const store = createMonadStore({ client });

  const subscription = store.dispatch(listInvitableMeshAgentsApi.endpoints.listInvitableMeshAgents.initiate());
  const result = await subscription;

  expect(result.data).toEqual([monadAgent]);
  expect(requests).toBe(1);
  subscription.unsubscribe();
});

test('manual MeshAgent catalog refresh waits for the daemon refresh response', async () => {
  let requests = 0;
  const client = {
    treaty: {
      v1: {
        mesh: {
          agents: {
            refresh: {
              post: async () => {
                requests += 1;
                return { data: { ok: true }, error: null, status: 200 };
              }
            }
          }
        }
      }
    },
    subscribeControl: () => () => {},
    streamEvents: () => () => {}
  } as unknown as MonadClient;
  const store = createMonadStore({ client });

  const result = await store.dispatch(refreshMeshAgentCatalogApi.endpoints.refreshMeshAgentCatalog.initiate());

  expect({ data: result.data, requests }).toEqual({ data: { ok: true }, requests: 1 });
});
