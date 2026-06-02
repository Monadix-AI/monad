import type { StreamError } from '@monad/client';
import type { EventId, MessageGenerationFrame, MessageId, SessionId } from '@monad/protocol';

import { clientOf } from '../../endpoint-helpers.ts';
import { sendMessageApi } from './send-message.ts';

export interface MessageGenerationStreamState {
  frames: MessageGenerationFrame[];
  streamError: { kind: StreamError['kind']; status?: number } | null;
}

export interface StreamMessageGenerationArg {
  sessionId: SessionId;
  messageId: MessageId;
  afterEventId?: EventId;
}

const FRAME_CAP = 512;

const streamMessageGenerationApi = sendMessageApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    streamMessageGeneration: builder.query<MessageGenerationStreamState, StreamMessageGenerationArg>({
      keepUnusedDataFor: 0,
      queryFn: () => ({ data: { frames: [], streamError: null } }),
      async onCacheEntryAdded(
        { sessionId, messageId, afterEventId },
        {
          cacheDataLoaded,
          cacheEntryRemoved,
          updateCachedData,
          extra
        }: {
          cacheDataLoaded: Promise<unknown>;
          cacheEntryRemoved: Promise<unknown>;
          updateCachedData: (fn: (draft: MessageGenerationStreamState) => void) => void;
          extra: unknown;
        }
      ) {
        let dispose: (() => void) | undefined;
        try {
          await cacheDataLoaded;
          dispose = clientOf({ extra }).streamMessageGeneration(
            sessionId,
            messageId,
            (frame) => {
              updateCachedData((draft) => {
                draft.streamError = null;
                draft.frames.push(frame);
                if (draft.frames.length > FRAME_CAP) draft.frames.splice(0, draft.frames.length - FRAME_CAP);
              });
            },
            {
              afterEventId,
              onError: (error) => {
                updateCachedData((draft) => {
                  draft.streamError = {
                    kind: error.kind,
                    ...(error.status === undefined ? {} : { status: error.status })
                  };
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

export const { useStreamMessageGenerationQuery } = streamMessageGenerationApi;
