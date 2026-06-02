import type { GetLawsResponse, OptionalMemoryScopeQuery } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const lawsApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getLaws: builder.query<GetLawsResponse, OptionalMemoryScopeQuery | undefined>({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.memory.laws.get({ query: arg ?? {} }))
    })
  })
});

export const { useGetLawsQuery } = lawsApi;
