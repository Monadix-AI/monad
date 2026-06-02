import { listMeshAgentPresetsResponseSchema, type MeshAgentPresetView } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const listMeshAgentPresetsApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    listMeshAgentPresets: builder.query<MeshAgentPresetView[], void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.agents.presets.get(),
          (raw) => listMeshAgentPresetsResponseSchema.parse(raw).presets
        ),
      providesTags: ['MeshAgentPresets']
    })
  })
});

export const { useListMeshAgentPresetsQuery } = listMeshAgentPresetsApi;
