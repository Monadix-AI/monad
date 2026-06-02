import type { SessionId } from '@monad/protocol';
import type { AppDispatch } from '../store/index.ts';

import { useStreamSessionQuery } from '@monad/client-rtk';
import { useEffect, useRef } from 'react';
import { batch, useDispatch } from 'react-redux';

import { appendToken, commitMessage } from '../store/server.ts';
import { useUIStore } from '../store/ui.ts';

export function useStream(sessionId: SessionId) {
  const dispatch = useDispatch<AppDispatch>();
  const setConnected = useUIStore((s) => s.setConnected);
  const stream = useStreamSessionQuery(sessionId);
  // Track cursor by length (O(1) slice) rather than by value (O(n) startsWith).
  const prevLenRef = useRef(0);
  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    setConnected(!stream.isError);
    return () => {
      setConnected(false);
    };
  }, [stream.isError, setConnected]);

  useEffect(() => {
    if (!stream.data) return;

    const streamingMsg = stream.data.messages.find((m) => m.streaming);
    const current = streamingMsg?.text ?? '';
    const delta = current.slice(prevLenRef.current);
    prevLenRef.current = current.length;

    const nextCount = stream.data.messages.filter((m) => !m.streaming).length;
    if (nextCount < prevMessageCountRef.current) {
      prevMessageCountRef.current = 0;
      prevLenRef.current = 0;
    }
    const settled = stream.data.messages.filter((m) => !m.streaming);
    const newMessages = settled.slice(prevMessageCountRef.current);
    prevMessageCountRef.current = nextCount;

    // Coalesce token append + any newly settled messages into one Redux update → one Ink re-render.
    batch(() => {
      if (delta) dispatch(appendToken(delta));
      for (const msg of newMessages) dispatch(commitMessage(msg.text));
    });
  }, [stream.data, dispatch]);
}
