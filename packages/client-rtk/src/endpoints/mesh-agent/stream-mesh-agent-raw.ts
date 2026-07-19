import type { MeshRawEvent, SessionId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

// Bounds the live buffer so an unbounded raw session (thousands of provider frames) can't grow the
// RTK cache without limit. `frameOffset` is the count of frames evicted from the front so far; a
// consumer computes its absolute read position as `frameOffset + frames.length` rather than trusting
// array length alone, which stays flat once the cap is reached.
const RAW_FRAME_CAP = 1000;

interface MeshAgentRawStreamState {
  fatalError: boolean;
  frames: MeshRawEvent[];
  frameOffset: number;
}

const streamMeshAgentRawApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamMeshAgentRaw: builder.query<
      MeshAgentRawStreamState,
      { id: string; transcriptTargetId: SessionId; afterCursor?: string }
    >({
      queryFn: () => ({ data: { fatalError: false, frames: [], frameOffset: 0 } }),
      async onCacheEntryAdded(
        { id, transcriptTargetId, afterCursor },
        {
          cacheDataLoaded,
          cacheEntryRemoved,
          updateCachedData,
          extra
        }: {
          cacheDataLoaded: Promise<unknown>;
          cacheEntryRemoved: Promise<unknown>;
          updateCachedData: (fn: (draft: MeshAgentRawStreamState) => void) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamMeshAgentRaw(
            id,
            transcriptTargetId,
            (frame) => {
              updateCachedData((draft) => {
                draft.fatalError = false;
                draft.frames.push(frame);
                if (draft.frames.length > RAW_FRAME_CAP) {
                  const overflow = draft.frames.length - RAW_FRAME_CAP;
                  draft.frames.splice(0, overflow);
                  draft.frameOffset += overflow;
                }
              });
            },
            {
              afterCursor,
              onError: (error) => {
                updateCachedData((draft) => {
                  draft.fatalError = error.kind === 'fatal';
                  draft.frameOffset += draft.frames.length;
                  draft.frames = [];
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

export const { useStreamMeshAgentRawQuery } = streamMeshAgentRawApi;
