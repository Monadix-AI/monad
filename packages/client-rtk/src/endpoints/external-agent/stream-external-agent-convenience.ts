import type { ExternalAgentConvenienceFrame, SessionId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sessionsApi } from '../sessions/index.ts';

// See stream-external-agent-raw.ts's RAW_FRAME_CAP comment — same bounded-buffer contract, applied to
// the convenience plane's projected frames.
const CONVENIENCE_FRAME_CAP = 1000;

interface ExternalAgentConvenienceStreamState {
  fatalError: boolean;
  frames: ExternalAgentConvenienceFrame[];
  frameOffset: number;
}

const streamExternalAgentConvenienceApi = sessionsApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamExternalAgentConvenience: builder.query<
      ExternalAgentConvenienceStreamState,
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
          updateCachedData: (fn: (draft: ExternalAgentConvenienceStreamState) => void) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamExternalAgentConvenience(
            id,
            transcriptTargetId,
            (frame) => {
              updateCachedData((draft) => {
                draft.fatalError = false;
                draft.frames.push(frame);
                if (draft.frames.length > CONVENIENCE_FRAME_CAP) {
                  const overflow = draft.frames.length - CONVENIENCE_FRAME_CAP;
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

export const { useStreamExternalAgentConvenienceQuery } = streamExternalAgentConvenienceApi;
