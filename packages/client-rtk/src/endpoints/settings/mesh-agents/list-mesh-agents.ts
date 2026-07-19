import type { MeshAgentView } from '@monad/protocol';

import { createEntityAdapter, type EntityState } from '@reduxjs/toolkit';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const meshAgentAdapter = createEntityAdapter<MeshAgentView, string>({ selectId: (a) => a.name });
export const meshAgentSelectors = meshAgentAdapter.getSelectors();

export const listMeshAgentsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMeshAgents: builder.query<EntityState<MeshAgentView, string>, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.agents.get(),
          (raw) => meshAgentAdapter.setAll(meshAgentAdapter.getInitialState(), raw.agents)
        ),
      providesTags: ['MeshAgents']
    })
  })
});

export const { useListMeshAgentsQuery } = listMeshAgentsApi;
