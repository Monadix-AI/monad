import type { ExternalAgentView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const externalAgentAdapter = createEntityAdapter<ExternalAgentView, string>({ selectId: (a) => a.name });
export const externalAgentSelectors = externalAgentAdapter.getSelectors();

export const listExternalAgentsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listExternalAgents: builder.query<EntityState<ExternalAgentView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['external-agents'].get(),
          (raw) => externalAgentAdapter.setAll(externalAgentAdapter.getInitialState(), raw.agents)
        ),
      providesTags: ['ExternalAgents']
    })
  })
});

export const { useListExternalAgentsQuery } = listExternalAgentsApi;
