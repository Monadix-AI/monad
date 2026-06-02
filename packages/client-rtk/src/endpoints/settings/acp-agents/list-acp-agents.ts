import type { AcpAgentView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const acpAgentAdapter = createEntityAdapter<AcpAgentView, string>({ selectId: (a) => a.name });
export const acpAgentSelectors = acpAgentAdapter.getSelectors();

export const listAcpAgentsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listAcpAgents: builder.query<EntityState<AcpAgentView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.settings['acp-agents'].get(),
          (raw) => acpAgentAdapter.setAll(acpAgentAdapter.getInitialState(), raw.agents)
        ),
      providesTags: ['AcpAgents']
    })
  })
});

export const { useListAcpAgentsQuery } = listAcpAgentsApi;
