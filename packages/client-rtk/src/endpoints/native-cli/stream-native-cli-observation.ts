import type { NativeCliObservationAccessResponse, TranscriptTargetId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export const streamNativeCliObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamNativeCliObservation: builder.query<
      NativeCliObservationAccessResponse | null,
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
            fn: (draft: NativeCliObservationAccessResponse | null) => NativeCliObservationAccessResponse
          ) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamNativeCliObservation(id, transcriptTargetId, (access) => {
            updateCachedData(() => access);
          });
        } catch {}
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamNativeCliObservationQuery } = streamNativeCliObservationApi;
