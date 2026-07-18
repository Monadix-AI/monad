import type { ExternalAgentUiObservationFrame, SessionId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

export interface ExternalAgentUiObservationStreamState {
  fatalError: boolean;
  frame: ExternalAgentUiObservationFrame | null;
}

export const streamExternalAgentUiObservationApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamExternalAgentUiObservation: builder.query<
      ExternalAgentUiObservationStreamState,
      { id: string; transcriptTargetId: SessionId }
    >({
      queryFn: () => ({ data: { fatalError: false, frame: null } }),
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
          updateCachedData: (fn: (draft: ExternalAgentUiObservationStreamState) => void) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamExternalAgentUiObservation(
            id,
            transcriptTargetId,
            (frame) => {
              updateCachedData((draft) => {
                draft.fatalError = false;
                draft.frame = frame;
              });
            },
            {
              onError: (error) => {
                updateCachedData((draft) => {
                  draft.fatalError = error.kind === 'fatal';
                  draft.frame = null;
                });
              }
            }
          );
        } catch {}
        await cacheEntryRemoved;
        dispose?.();
      }
    })
  })
});

export const { useStreamExternalAgentUiObservationQuery } = streamExternalAgentUiObservationApi;
