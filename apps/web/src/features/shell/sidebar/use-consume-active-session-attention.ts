import type { SessionId } from '@monad/protocol';

import { useConsumeSessionAttentionMutation } from '@monad/client-rtk';
import { useEffect, useRef } from 'react';

export function useConsumeActiveSessionAttention(sessionId: SessionId | null, itemKeys: readonly string[]): void {
  const [consume] = useConsumeSessionAttentionMutation();
  const pendingRef = useRef('');

  useEffect(() => {
    if (!sessionId || itemKeys.length === 0) return;
    const signature = `${sessionId}:${itemKeys.join('\u0000')}`;
    if (pendingRef.current === signature) return;
    pendingRef.current = signature;
    void consume({ sessionId, itemKeys: [...itemKeys], cause: 'open' })
      .unwrap()
      .catch(() => {
        if (pendingRef.current === signature) pendingRef.current = '';
      });
  }, [consume, itemKeys, sessionId]);
}
