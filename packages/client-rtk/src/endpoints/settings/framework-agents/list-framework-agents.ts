import type { FrameworkAgentView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const frameworkAgentAdapter = createEntityAdapter<FrameworkAgentView, string>({ selectId: (a) => a.name });
export const frameworkAgentSelectors = frameworkAgentAdapter.getSelectors();

export const listFrameworkAgentsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listFrameworkAgents: builder.query<EntityState<FrameworkAgentView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['framework-agents'].get(),
          (raw) => frameworkAgentAdapter.setAll(frameworkAgentAdapter.getInitialState(), raw.agents)
        ),
      providesTags: ['FrameworkAgents']
    })
  })
});

export const { useListFrameworkAgentsQuery } = listFrameworkAgentsApi;
