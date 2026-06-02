import type { MonadClient } from '@monad/client';
import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { listInvitableMeshAgentsApi } from '../../src/endpoints/mesh-agent/list-invitable-mesh-agents.ts';
import { streamControlApi } from '../../src/endpoints/sessions/stream-control.ts';
import { listMeshAgentPresetsApi } from '../../src/endpoints/settings/mesh-agents/list-mesh-agent-presets.ts';
import { listMeshAgentsApi } from '../../src/endpoints/settings/mesh-agents/list-mesh-agents.ts';
import { createMonadStore } from '../../src/index.ts';

test('catalog update events refetch only the changed MeshAgent resource', async () => {
  const requests = { agents: 0, presets: 0, invitable: 0 };
  let receiveControl: ((event: Event) => void) | undefined;
  let resolveSubscribed: (() => void) | undefined;
  let resolvePresetRefetched: (() => void) | undefined;
  const subscribed = new Promise<void>((resolve) => {
    resolveSubscribed = resolve;
  });
  const presetRefetched = new Promise<void>((resolve) => {
    resolvePresetRefetched = resolve;
  });
  const client = {
    treaty: {
      v1: {
        mesh: {
          agents: {
            get: async () => {
              requests.agents += 1;
              return { data: { agents: [] }, error: null, status: 200 };
            },
            presets: {
              get: async () => {
                requests.presets += 1;
                if (requests.presets === 2) resolvePresetRefetched?.();
                return { data: { presets: [] }, error: null, status: 200 };
              }
            }
          },
          'invitable-agents': {
            get: async () => {
              requests.invitable += 1;
              return { data: { agents: [] }, error: null, status: 200 };
            }
          }
        }
      }
    },
    subscribeControl: (handler: (event: Event) => void) => {
      receiveControl = handler;
      resolveSubscribed?.();
      return () => {};
    },
    streamEvents: () => () => {}
  } as unknown as MonadClient;
  const store = createMonadStore({ client });
  const subscriptions = [
    store.dispatch(listMeshAgentsApi.endpoints.listMeshAgents.initiate()),
    store.dispatch(listMeshAgentPresetsApi.endpoints.listMeshAgentPresets.initiate()),
    store.dispatch(listInvitableMeshAgentsApi.endpoints.listInvitableMeshAgents.initiate()),
    store.dispatch(streamControlApi.endpoints.streamControl.initiate())
  ];
  await Promise.all([...subscriptions, subscribed]);

  receiveControl?.({
    actorAgentId: null,
    at: '2026-08-03T05:00:00.000Z',
    id: 'evt_100000000000',
    payload: { resources: ['presets'], updatedAt: '2026-08-03T05:00:00.000Z' },
    sessionId: 'ses_100000000000',
    type: 'mesh.catalog.updated'
  });
  await presetRefetched;

  expect(requests).toEqual({ agents: 1, presets: 2, invitable: 1 });
  for (const subscription of subscriptions) subscription.unsubscribe();
});
