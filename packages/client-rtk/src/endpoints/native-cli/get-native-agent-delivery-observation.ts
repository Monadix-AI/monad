import type { NativeAgentDeliveryId, NativeCliObservationAccessResponse, TranscriptTargetId } from '@monad/protocol';

import { nativeCliObservationAccessResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getNativeAgentDeliveryObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeAgentDeliveryObservation: builder.query<
      NativeCliObservationAccessResponse,
      { id: NativeAgentDeliveryId; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api).treaty.v1['native-agent-deliveries']({ id }).observation.get({
              query: { transcriptTargetId }
            }),
          (raw) => nativeCliObservationAccessResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetNativeAgentDeliveryObservationQuery, useLazyGetNativeAgentDeliveryObservationQuery } =
  getNativeAgentDeliveryObservationApi;
