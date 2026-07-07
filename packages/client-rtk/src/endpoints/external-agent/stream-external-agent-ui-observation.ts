import type { ExternalAgentUiObservationFrame, TranscriptTargetId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const streamExternalAgentUiObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamExternalAgentUiObservation: builder.query<
      ExternalAgentUiObservationFrame | null,
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
            fn: (draft: ExternalAgentUiObservationFrame | null) => ExternalAgentUiObservationFrame
          ) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamExternalAgentUiObservation(id, transcriptTargetId, (frame) => {
            updateCachedData(() => frame);
          });
        } catch {}
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamExternalAgentUiObservationQuery } = streamExternalAgentUiObservationApi;
