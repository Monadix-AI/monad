import type { ListAgentsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const listAgentsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAgents: builder.query<ListAgentsResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.agents.get()),
      providesTags: ['Agents']
    })
  })
});

export const { useListAgentsQuery } = listAgentsApi;
