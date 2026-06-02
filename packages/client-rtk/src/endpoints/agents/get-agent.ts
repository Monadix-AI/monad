import type { AgentId, GetAgentResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const getAgentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAgent: builder.query<GetAgentResponse, AgentId>({
      queryFn: (agentId: AgentId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).get()),
      providesTags: (_res, _err, agentId) => [{ type: 'Agents', id: agentId }]
    })
  })
});

export const { useGetAgentQuery } = getAgentApi;
