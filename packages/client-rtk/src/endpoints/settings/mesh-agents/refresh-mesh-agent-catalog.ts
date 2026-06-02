import { okResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../../endpoint-helpers.ts';
import { sessionsApi } from '../../sessions/index.ts';

export const refreshMeshAgentCatalogApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    refreshMeshAgentCatalog: builder.mutation<{ ok: true }, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.agents.refresh.post(),
          (raw) => okResponseSchema.parse(raw)
        ),
      invalidatesTags: ['MeshAgents', 'MeshAgentPresets', 'InvitableMeshAgents']
    })
  })
});

export const { useRefreshMeshAgentCatalogMutation } = refreshMeshAgentCatalogApi;
