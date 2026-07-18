import type { Message, Participant } from '../../experience/types.ts';

import { sortMessagesOldestFirst } from './projection.ts';

export type OptimisticMessageStatus = 'sending' | 'sent' | 'failed';
export type OptimisticChatMessage = Message & {
  kind: 'human';
  localStatus: OptimisticMessageStatus;
  retrySend: () => void;
};

export function createOptimisticUserMessage({
  createdAt = new Date().toISOString(),
  human,
  id,
  retry,
  status,
  text
}: {
  createdAt?: string;
  human: Participant;
  id: string;
  retry: () => void;
  status: OptimisticMessageStatus;
  text: string;
}): OptimisticChatMessage {
  return {
    id,
    renderKey: id,
    authorId: human.id,
    authorName: human.name,
    av: human.av,
    avatarUrl: human.avatarUrl,
    icon: human.icon,
    kind: 'human',
    tag: human.tag,
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
  const matchedOptimisticIds = new Set<string>();
  const merged = messages.map((message) => {
    const optimisticMessage = optimisticMessages.find(
      (candidate) => !matchedOptimisticIds.has(candidate.id) && isServerEcho(message, candidate)
    );
    if (optimisticMessage) matchedOptimisticIds.add(optimisticMessage.id);
    return optimisticMessage ? { ...message, renderKey: optimisticMessage.renderKey ?? optimisticMessage.id } : message;
  });
  const remaining = optimisticMessages.filter((optimisticMessage) => !matchedOptimisticIds.has(optimisticMessage.id));
  return sortMessagesOldestFirst([...merged, ...remaining]);
}
