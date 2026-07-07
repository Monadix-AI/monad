import type { GetExternalAgentResponse } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { listExternalAgentsApi } from './list-external-agents.ts';

const getExternalAgentApi = listExternalAgentsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgent: builder.query<GetExternalAgentResponse, string>({
      queryFn: (name: string, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.settings['external-agents']({ name }).get()),
      providesTags: (_res, _err, name) => [{ type: 'ExternalAgents', id: name }]
    })
  })
});

export const { useGetExternalAgentQuery } = getExternalAgentApi;
