import type { NativeCliObservationAccessResponse, TranscriptTargetId } from '@monad/protocol';

import { nativeCliObservationAccessResponseSchema } from '@monad/protocol';

import { clientOf, runTreaty } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const getNativeCliObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getNativeCliObservation: builder.query<
      NativeCliObservationAccessResponse,
      { id: string; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: ({ id, transcriptTargetId }, api: { extra: unknown }) =>
        runTreaty(
          () =>
            clientOf(api).treaty.v1['native-cli-sessions']({ id }).observation.get({ query: { transcriptTargetId } }),
          (raw) => nativeCliObservationAccessResponseSchema.parse(raw)
        )
    })
  })
});

export const { useGetNativeCliObservationQuery } = getNativeCliObservationApi;
