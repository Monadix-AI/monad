import type { IndexerStatus } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const indexerApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getIndexerStatus: builder.query<IndexerStatus, void>({
      queryFn: (_arg, api: { extra: unknown }) => runTreaty(() => clientOf(api).treaty.v1.indexer.status.get()),
      providesTags: ['Indexer']
    })
  })
});

export const { useGetIndexerStatusQuery } = indexerApi;
