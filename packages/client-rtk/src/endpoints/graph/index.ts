import type { GetGraphResponse, OptionalMemoryScopeQuery } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const graphApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getGraph: builder.query<GetGraphResponse, OptionalMemoryScopeQuery | undefined>({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.graph.get({ query: arg ?? {} }))
    })
  })
});

export const { useGetGraphQuery } = graphApi;
