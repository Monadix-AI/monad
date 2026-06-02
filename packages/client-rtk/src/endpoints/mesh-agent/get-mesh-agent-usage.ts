import type { MeshAgentUsageResponse } from '@monad/protocol';

import { meshAgentUsageResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getMeshAgentUsageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshAgentUsage: builder.query<MeshAgentUsageResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.agents({ name }).usage.get(),
          (raw) => meshAgentUsageResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetMeshAgentUsageQuery, useLazyGetMeshAgentUsageQuery } = getMeshAgentUsageApi;
