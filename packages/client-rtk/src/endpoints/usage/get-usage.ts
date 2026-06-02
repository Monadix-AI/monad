import type { GetUsageResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

// The global usage ledger: cumulative totals + a per-provider/model rollup + the full
// day×provider×model×category breakdown for the multi-dimensional view.
export const getUsageApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getUsage: builder.query<GetUsageResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.usage.get()),
      providesTags: ['Usage']
    })
  })
});

export const { useGetUsageQuery } = getUsageApi;
