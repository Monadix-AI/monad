import type { GetAcpAgentResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listAcpAgentsApi } from './list-acp-agents.ts';

const getAcpAgentApi = listAcpAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAcpAgent: builder.query<GetAcpAgentResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['acp-agents']({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'AcpAgents', id: name }]
    })
  })
});

export const { useGetAcpAgentQuery } = getAcpAgentApi;
