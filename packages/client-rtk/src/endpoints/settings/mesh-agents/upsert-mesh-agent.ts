import type { MeshAgentView, OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMeshAgentsApi, meshAgentAdapter } from './list-mesh-agents.ts';

export const upsertMeshAgentApi = listMeshAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    upsertMeshAgent: builder.mutation<OkResponse, MeshAgentView>({
      queryFn: (agent: MeshAgentView, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.mesh.agents({ name: agent.name }).put({ agent })),
      async onQueryStarted(agent, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listMeshAgentsApi.util.updateQueryData('listMeshAgents', undefined, (draft) => {
            meshAgentAdapter.upsertOne(draft, agent);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['MeshAgents']
    })
  })
});

export const { useUpsertMeshAgentMutation } = upsertMeshAgentApi;
