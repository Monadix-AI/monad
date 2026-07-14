import type { SessionId } from '@monad/protocol';
import type { AppDispatch } from '../store/index.ts';

import { useStreamSessionQuery } from '@monad/client-rtk';
import { useEffect, useRef } from 'react';
import { batch, useDispatch } from 'react-redux';

import { advanceStreamCursor, type StreamCursor, settledAssistantMessages } from '../shell/stream-model.ts';
import { appendToken, commitMessage } from '../store/server.ts';
import { useUIStore } from '../store/ui.ts';

export function useStream(sessionId: SessionId) {
  const dispatch = useDispatch<AppDispatch>();
  const setConnected = useUIStore((s) => s.setConnected);
  const stream = useStreamSessionQuery(sessionId);
  const streamCursorRef = useRef<StreamCursor>({ length: 0, messageId: null });
  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    setConnected(!stream.isError);
    return () => {
      setConnected(false);
    };
  }, [stream.isError, setConnected]);

  useEffect(() => {
    if (!stream.data) return;

    const streamingMsg = stream.data.messages.find((message) => message.role === 'assistant' && message.streaming);
    const tokenUpdate = advanceStreamCursor(streamCursorRef.current, streamingMsg);
    streamCursorRef.current = tokenUpdate.cursor;

    const settled = settledAssistantMessages(stream.data.messages);
    const nextCount = settled.length;
    if (nextCount < prevMessageCountRef.current) {
      prevMessageCountRef.current = 0;
    }
    const newMessages = settled.slice(prevMessageCountRef.current);
    prevMessageCountRef.current = nextCount;

    // Coalesce token append + any newly settled messages into one Redux update → one Ink re-render.
    batch(() => {
      if (tokenUpdate.delta) dispatch(appendToken(tokenUpdate.delta));
      for (const msg of newMessages) dispatch(commitMessage(msg.text));
    });
  }, [stream.data, dispatch]);
}
