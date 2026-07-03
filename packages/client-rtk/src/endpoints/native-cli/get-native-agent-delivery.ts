import type { GetNativeAgentDeliveryResponse, NativeAgentDeliveryId, TranscriptTargetId } from '@monad/protocol';

import { getNativeAgentDeliveryResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getNativeAgentDeliveryApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeAgentDelivery: builder.query<
      GetNativeAgentDeliveryResponse,
      { id: NativeAgentDeliveryId; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () => clientOf(api).treaty.v1['native-agent-deliveries']({ id }).get({ query: { transcriptTargetId } }),
          (raw) => getNativeAgentDeliveryResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetNativeAgentDeliveryQuery } = getNativeAgentDeliveryApi;
