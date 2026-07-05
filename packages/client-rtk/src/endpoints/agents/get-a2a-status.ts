import type { AgentId, GetA2aAgentStatusResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const getA2aStatusApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getA2aStatus: builder.query<GetA2aAgentStatusResponse, AgentId>({
      queryFn: (agentId: AgentId, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.agents({ id: agentId }).a2a.get()),
      providesTags: (_res, _err, agentId) => [{ type: 'Agents', id: agentId }]
    })
  })
});

export const { useGetA2aStatusQuery } = getA2aStatusApi;
