import type { Agent } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { apiSlice } from '../../api-slice.ts';
import { clientOf, runTreaty } from '../../endpoint-helpers.ts';

export const agentAdapter = createEntityAdapter<Agent, string>({ selectId: (a) => a.id });
export const agentSelectors = agentAdapter.getSelectors();

export const listAgentsApi = apiSlice.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAgents: builder.query<EntityState<Agent, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.agents.get(),
          (raw) => agentAdapter.setAll(agentAdapter.getInitialState(), raw.agents)
        ),
      providesTags: ['Agents']
    })
  })
});

export const { useListAgentsQuery } = listAgentsApi;
