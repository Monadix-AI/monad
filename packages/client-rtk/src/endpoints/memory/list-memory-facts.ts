import type { Fact, ListMemoryFactsQuery, ListMemoryFactsResponse } from '@monad/protocol';

import { createEntityAdapter } from '@reduxjs/toolkit';

import { type NormalizedCursorPaginateResponse } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { setMemoryGraphApi } from './set-memory-graph.ts';

const factAdapter = createEntityAdapter<Fact>();
export const factSelectors = factAdapter.getSelectors();

export type ListMemoryFactsResult = NormalizedCursorPaginateResponse<Fact, 'facts', ListMemoryFactsResponse>;

export const listMemoryFactsApi = setMemoryGraphApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMemoryFacts: builder.query<ListMemoryFactsResult, ListMemoryFactsQuery>({
      queryFn: (arg: ListMemoryFactsQuery, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.memory.facts.get({ query: arg }),
          (raw) => ({
            ...raw,
            facts: factAdapter.setAll(factAdapter.getInitialState(), raw.facts)
          })
        ),
      providesTags: ['Memory']
    })
  })
});

export const { useListMemoryFactsQuery } = listMemoryFactsApi;
