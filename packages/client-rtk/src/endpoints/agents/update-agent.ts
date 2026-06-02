import type { AgentId, GetAgentResponse, UpdateAgentRequest } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getAgentApi } from './get-agent.ts';
import { listAgentsApi } from './list-agents.ts';

export type UpdateAgentArg = { agentId: AgentId } & UpdateAgentRequest;

export const updateAgentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    updateAgent: builder.mutation<GetAgentResponse, UpdateAgentArg>({
      queryFn: ({ agentId, ...patch }: UpdateAgentArg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).patch(patch)),
      async onQueryStarted({ agentId, ...patch }, { dispatch, queryFulfilled }) {
        const listPatch = dispatch(
          listAgentsApi.util.updateQueryData('listAgents', undefined, (draft) => {
            const agent = draft.agents.find((a) => a.id === agentId);
            if (agent) Object.assign(agent, patch);
          })
        );
        const agentPatch = dispatch(
          getAgentApi.util.updateQueryData('getAgent', agentId, (draft) => {
            Object.assign(draft.agent, patch);
          })
        );
        try {
          await queryFulfilled;
        } catch {
          listPatch.undo();
          agentPatch.undo();
        }
      },
      invalidatesTags: ['Agents']
    })
  })
});

export const { useUpdateAgentMutation } = updateAgentApi;
