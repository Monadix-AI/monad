import type { MemoryCoreResponse, MemoryScopeQuery } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { listMemoryFactsApi } from './list-memory-facts.ts';

export const getMemoryCoreApi = listMemoryFactsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMemoryCore: builder.query<MemoryCoreResponse, MemoryScopeQuery>({
      queryFn: (arg: MemoryScopeQuery, api: { extra: unknown }) =>
        runTreaty(() => clientOf(api).treaty.v1.memory.core.get({ query: arg })),
      providesTags: ['Memory']
    })
  })
});

export const { useGetMemoryCoreQuery } = getMemoryCoreApi;
