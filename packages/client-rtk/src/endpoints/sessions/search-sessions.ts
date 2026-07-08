import type { SearchSessionsRequest, SearchSessionsResponse } from '@monad/protocol';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

const searchSessionsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    // Returns the full response (hits + indexingPending) so the UI can flag incomplete recall
    // while the background embedding indexer is still catching up.
    searchSessions: builder.query<SearchSessionsResponse, SearchSessionsRequest>({
      queryFn: ({ q, mode, limit, sessionId }: SearchSessionsRequest, api: { extra: unknown }) =>
        runTreaty(() =>
          clientOf(api).treaty.v1.sessions.search.get({
            query: { q, mode, limit, sessionId }
          })
        )
    })
  })
});

export const { useSearchSessionsQuery } = searchSessionsApi;
