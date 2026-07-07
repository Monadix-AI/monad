import type { ExternalAgentObservationAccessResponse, TranscriptTargetId } from '@monad/protocol';

import { externalAgentObservationAccessResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getExternalAgentObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getExternalAgentObservation: builder.query<
      ExternalAgentObservationAccessResponse,
      { id: string; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api)
              .treaty.v1['external-agent-sessions']({ id })
              .observation.get({ query: { transcriptTargetId } }),
          (raw) => externalAgentObservationAccessResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetExternalAgentObservationQuery, useLazyGetExternalAgentObservationQuery } =
  getExternalAgentObservationApi;
