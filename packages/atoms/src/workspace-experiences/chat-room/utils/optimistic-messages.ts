import type { Message } from '../../experience/types.ts';

export type OptimisticMessageStatus = 'sending' | 'sent' | 'failed';
export type OptimisticChatMessage = Message & {
  kind: 'human';
  localStatus: OptimisticMessageStatus;
  retrySend: () => void;
};

export function createOptimisticUserMessage({
  createdAt = new Date().toISOString(),
  id,
  retry,
  status,
  text
}: {
  createdAt?: string;
  id: string;
  retry: () => void;
  status: OptimisticMessageStatus;
  text: string;
}): OptimisticChatMessage {
  return {
    id,
    authorId: 'human',
    authorName: 'You',
    av: 'YO',
    kind: 'human',
    tag: 'User',
    time: '',
    text,
    localStatus: status,
    retrySend: retry,
    orderKey: createdAt
  };
}

function isServerEcho(message: Message, optimisticMessage: OptimisticChatMessage): boolean {
  if (message.kind !== 'human' || message.localStatus !== undefined) return false;
  if (message.text.trim() !== optimisticMessage.text.trim()) return false;
  if (!message.orderKey || !optimisticMessage.orderKey) return false;
  return message.orderKey >= optimisticMessage.orderKey;
}

export function mergeOptimisticMessages(messages: Message[], optimisticMessages: OptimisticChatMessage[]): Message[] {
  if (optimisticMessages.length === 0) return messages;
  const remaining = optimisticMessages.filter(
    (optimisticMessage) => !messages.some((message) => isServerEcho(message, optimisticMessage))
  );
  return [...messages, ...remaining];
}
