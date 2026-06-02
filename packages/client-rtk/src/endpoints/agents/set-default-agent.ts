import type { GetDefaultAgentResponse, OkResponse, SetDefaultAgentRequest } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { getDefaultAgentApi } from './get-default-agent.ts';

const setDefaultAgentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    setDefaultAgent: builder.mutation<OkResponse, SetDefaultAgentRequest>({
      queryFn: (body: SetDefaultAgentRequest, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents.default.put(body)),
      async onQueryStarted({ agentId }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          getDefaultAgentApi.util.updateQueryData('getDefaultAgent', undefined, (draft: GetDefaultAgentResponse) => {
            draft.agentId = agentId;
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

export const { useSetDefaultAgentMutation } = setDefaultAgentApi;
