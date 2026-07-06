import type { CreateAgentRequest, CreateAgentResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { agentAdapter, listAgentsApi } from './list-agents.ts';

export const createAgentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    createAgent: builder.mutation<CreateAgentResponse, CreateAgentRequest>({
      queryFn: (body: CreateAgentRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents.post(body)),
      async onQueryStarted(_body, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            listAgentsApi.util.updateQueryData('listAgents', undefined, (draft) => {
              agentAdapter.addOne(draft, data.agent);
            })
          );
        } catch {
          // let invalidatesTags handle recovery
        }
      },
      invalidatesTags: ['Agents']
    })
  })
});

export const { useCreateAgentMutation } = createAgentApi;
