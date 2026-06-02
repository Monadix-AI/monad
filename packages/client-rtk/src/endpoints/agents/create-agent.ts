import type { CreateAgentRequest, CreateAgentResponse, ListAgentsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listAgentsApi } from './list-agents.ts';

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
            listAgentsApi.util.updateQueryData('listAgents', undefined, (draft: ListAgentsResponse) => {
              draft.agents.push(data.agent);
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
