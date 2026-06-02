import type { MeshUsageOverviewResponse } from '@monad/protocol';

import { meshUsageOverviewResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

const getMeshUsageOverviewApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getMeshUsageOverview: builder.query<MeshUsageOverviewResponse, void>({
      queryFn: (_arg, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1.mesh.usage.get(),
          (raw) => meshUsageOverviewResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetMeshUsageOverviewQuery } = getMeshUsageOverviewApi;
