import type { Fact, MemoryScopeQuery } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { setMemoryGraphApi } from './set-memory-graph.ts';

export const factAdapter = createEntityAdapter<Fact>();
export const factSelectors = factAdapter.getSelectors();

export const listMemoryFactsApi = setMemoryGraphApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMemoryFacts: builder.query<EntityState<Fact, string>, MemoryScopeQuery>({
      queryFn: (arg: MemoryScopeQuery, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.memory.facts.get({ query: arg }),
          (raw) => factAdapter.setAll(factAdapter.getInitialState(), raw.facts)
        ),
      providesTags: ['Memory']
    })
  })
});

export const { useListMemoryFactsQuery } = listMemoryFactsApi;
