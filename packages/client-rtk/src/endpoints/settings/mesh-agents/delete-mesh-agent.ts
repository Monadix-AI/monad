import type { OkResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listMeshAgentsApi, meshAgentAdapter } from './list-mesh-agents.ts';
import { upsertMeshAgentApi } from './upsert-mesh-agent.ts';

const deleteMeshAgentApi = upsertMeshAgentApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteMeshAgent: builder.mutation<OkResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.mesh.agents({ name }).delete()),
      async onQueryStarted(name, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listMeshAgentsApi.util.updateQueryData('listMeshAgents', undefined, (draft) => {
            meshAgentAdapter.removeOne(draft, name);
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

export const { useDeleteMeshAgentMutation } = deleteMeshAgentApi;
