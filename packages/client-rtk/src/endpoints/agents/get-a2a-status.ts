import type { AgentId, GetA2aAgentStatusResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

type A2aStatusTreaty = {
  a2a: {
    get: () => Promise<{ data: GetA2aAgentStatusResponse | null | undefined; error: unknown }>;
  };
};

const getA2aStatusApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getA2aStatus: builder.query<GetA2aAgentStatusResponse, AgentId>({
      queryFn: (agentId: AgentId, api: { extra: unknown }) => {
        const agent = clientOf(api).treaty.v1.agents({ id: agentId }) as unknown as A2aStatusTreaty;
        return runTreaty(() => agent.a2a.get());
      },
      providesTags: (_res, _err, agentId) => [{ type: 'Agents', id: agentId }]
    })
  })
});

export const { useGetA2aStatusQuery } = getA2aStatusApi;
