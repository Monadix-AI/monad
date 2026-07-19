import type { MessageId, SessionId, UIItem } from '@monad/protocol';

import { useStreamMessageGenerationQuery } from '@monad/client-rtk';
import { messageIdSchema } from '@monad/protocol';
import { memo } from 'react';

export function streamingMessageIds(items: readonly UIItem[]): MessageId[] {
  const ids = new Set<MessageId>();
  for (const item of items) {
    if (item.kind !== 'message' || item.status !== 'streaming') continue;
    const parsed = messageIdSchema.safeParse(item.id);
    if (parsed.success) ids.add(parsed.data);
  }
  return [...ids];
}

const MessageGenerationStream = memo(function MessageGenerationStream({
  messageId,
  sessionId
}: {
  messageId: MessageId;
  sessionId: SessionId;
}) {
  useStreamMessageGenerationQuery({ messageId, sessionId });
  return null;
});

export const VisibleMessageGenerationStreams = memo(function VisibleMessageGenerationStreams({
  items,
  sessionId
}: {
  items: readonly UIItem[];
  sessionId: SessionId | null;
}) {
  if (!sessionId) return null;
  return streamingMessageIds(items).map((messageId) => (
    <MessageGenerationStream
      key={messageId}
      messageId={messageId}
      sessionId={sessionId}
    />
  ));
});
