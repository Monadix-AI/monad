import type { ExternalAgentUsageResponse } from '@monad/protocol';

import { externalAgentUsageResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getExternalAgentUsageApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentUsage: builder.query<ExternalAgentUsageResponse, string>({
      queryFn: (name, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['external-agents']({ name }).usage.get(),
          (raw) => externalAgentUsageResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetExternalAgentUsageQuery, useLazyGetExternalAgentUsageQuery } = getExternalAgentUsageApi;
