import type { GetStatsResponse, StatsRange } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const getStatsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getStats: builder.query<GetStatsResponse, StatsRange | undefined>({
      queryFn: (range = 'all', api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.stats.get({ query: { range: range ?? 'all' } })),
      providesTags: ['Stats']
    })
  })
});

export const { useGetStatsQuery } = getStatsApi;
