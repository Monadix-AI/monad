import type { GetUsageQuery, GetUsageResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// The global usage ledger: cumulative totals + a per-provider/model rollup + the paginated
// day×provider×model×category breakdown for the multi-dimensional view.
export const getUsageApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getUsage: builder.query<GetUsageResponse, GetUsageQuery | undefined>({
      queryFn: (arg, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.usage.get({ query: arg ?? {} })),
      providesTags: ['Usage']
    })
  })
});

export const { useGetUsageQuery } = getUsageApi;
