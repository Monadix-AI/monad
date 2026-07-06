import type { AgentId, OkResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { agentAdapter, listAgentsApi } from './list-agents.ts';

export const deleteAgentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    deleteAgent: builder.mutation<OkResponse, AgentId>({
      queryFn: (agentId: AgentId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).delete()),
      async onQueryStarted(agentId, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          listAgentsApi.util.updateQueryData('listAgents', undefined, (draft) => {
            agentAdapter.removeOne(draft, agentId);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          patch.undo();
        }
      },
      invalidatesTags: ['Agents']
    })
  })
});

export const { useDeleteAgentMutation } = deleteAgentApi;
