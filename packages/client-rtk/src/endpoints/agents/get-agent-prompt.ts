import type { AgentId, GetAgentPromptResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const getAgentPromptApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAgentPrompt: builder.query<GetAgentPromptResponse, AgentId>({
      queryFn: (agentId: AgentId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).prompt.get()),
      providesTags: (_res, _err, agentId) => [{ type: 'Agents', id: `prompt:${agentId}` }]
    })
  })
});

export const { useGetAgentPromptQuery } = getAgentPromptApi;
