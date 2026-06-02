import type { GetDefaultAgentResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const getDefaultAgentApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getDefaultAgent: builder.query<GetDefaultAgentResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.agents.default.get()),
      providesTags: ['Agents']
    })
  })
});

export const { useGetDefaultAgentQuery } = getDefaultAgentApi;
