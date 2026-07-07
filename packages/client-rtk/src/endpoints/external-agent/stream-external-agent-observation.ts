import type { ExternalAgentObservationAccessResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const streamExternalAgentObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamExternalAgentObservation: builder.query<
      ExternalAgentObservationAccessResponse | null,
      { id: string; transcriptTargetId: TranscriptTargetId }
    >({
      queryFn: () => ({ data: null }),
      async onCacheEntryAdded(
        { id, transcriptTargetId },
        {
          cacheDataLoaded,
          cacheEntryRemoved,
          updateCachedData,
          extra
        }: {
          cacheDataLoaded: Promise<unknown>;
          cacheEntryRemoved: Promise<unknown>;
          updateCachedData: (
            fn: (draft: ExternalAgentObservationAccessResponse | null) => ExternalAgentObservationAccessResponse
          ) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamExternalAgentObservation(id, transcriptTargetId, (access) => {
            updateCachedData(() => access);
          });
        } catch {}
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamExternalAgentObservationQuery } = streamExternalAgentObservationApi;
