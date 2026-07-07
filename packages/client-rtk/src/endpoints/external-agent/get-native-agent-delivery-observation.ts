import type {
  ExternalAgentObservationAccessResponse,
  NativeAgentDeliveryId,
  TranscriptTargetId
} from '@monad/protocol';

import { externalAgentObservationAccessResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getNativeAgentDeliveryObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeAgentDeliveryObservation: builder.query<
      ExternalAgentObservationAccessResponse,
      { id: NativeAgentDeliveryId; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api).treaty.v1['native-agent-deliveries']({ id }).observation.get({
              query: { transcriptTargetId }
            }),
          (raw) => externalAgentObservationAccessResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetNativeAgentDeliveryObservationQuery, useLazyGetNativeAgentDeliveryObservationQuery } =
  getNativeAgentDeliveryObservationApi;
