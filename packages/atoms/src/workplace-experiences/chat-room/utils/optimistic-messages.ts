import type { SendMessageAttachment } from '@monad/protocol';
import type { Message, MessageAttachment, Participant } from '../../experience/types.ts';

import { sortMessagesOldestFirst } from './projection.ts';

export type OptimisticMessageStatus = 'sending' | 'sent' | 'failed';
export type OptimisticChatMessage = Message & {
  kind: 'human';
  localStatus: OptimisticMessageStatus;
  precedingMessageId?: string;
  retrySend: () => void;
};

export function createOptimisticUserMessage({
  attachments,
  createdAt = new Date().toISOString(),
  human,
  id,
  precedingMessageId,
  replyToMessageId,
  retry,
  status,
  text
}: {
  attachments?: SendMessageAttachment[];
  createdAt?: string;
  human: Participant;
  id: string;
  precedingMessageId?: string;
  replyToMessageId?: string;
  retry: () => void;
  status: OptimisticMessageStatus;
  text: string;
}): OptimisticChatMessage {
  const presentedAttachments: MessageAttachment[] = (attachments ?? []).map((attachment, index) => ({
    id: `att_${id.replace(/[^a-zA-Z0-9]/g, '')}_${index}` as MessageAttachment['id'],
    name: attachment.name,
    mime: attachment.mediaType || 'application/octet-stream',
    bytes: attachment.size,
    createdAt
  }));
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
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(presentedAttachments.length ? { attachments: presentedAttachments } : {}),
    localStatus: status,
    ...(precedingMessageId ? { precedingMessageId } : {}),
    retrySend: retry,
    orderKey: createdAt
  };
}

function attachmentSignature(attachments: readonly MessageAttachment[] | undefined): string {
  return (attachments ?? []).map(({ bytes, mime, name }) => `${name}\u0000${mime}\u0000${bytes}`).join('\u0001');
}

function isServerEcho(
  message: Message,
  optimisticMessage: OptimisticChatMessage,
  messagesById: ReadonlyMap<string, Message>
): boolean {
  if (message.kind !== 'human' || message.localStatus !== undefined) return false;
  if (message.text.trim() !== optimisticMessage.text.trim()) return false;
  if (message.replyToMessageId !== optimisticMessage.replyToMessageId) return false;
  if (attachmentSignature(message.attachments) !== attachmentSignature(optimisticMessage.attachments)) return false;
  if (!message.orderKey || !optimisticMessage.orderKey) return false;
  if (optimisticMessage.precedingMessageId) {
    const precedingMessage = messagesById.get(optimisticMessage.precedingMessageId);
    if (precedingMessage?.orderKey) {
      return message.id !== precedingMessage.id && message.orderKey >= precedingMessage.orderKey;
    }
  }
  return message.orderKey >= optimisticMessage.orderKey;
}

export function mergeOptimisticMessages(messages: Message[], optimisticMessages: OptimisticChatMessage[]): Message[] {
  if (optimisticMessages.length === 0) return messages;
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const matchedOptimisticIds = new Set<string>();
  const merged = messages.map((message) => {
    const optimisticMessage = optimisticMessages.find(
      (candidate) => !matchedOptimisticIds.has(candidate.id) && isServerEcho(message, candidate, messagesById)
    );
    if (optimisticMessage) matchedOptimisticIds.add(optimisticMessage.id);
    return optimisticMessage ? { ...message, renderKey: optimisticMessage.renderKey ?? optimisticMessage.id } : message;
  });
  const remaining = optimisticMessages.filter((optimisticMessage) => !matchedOptimisticIds.has(optimisticMessage.id));
  if (remaining.length === 0) return sortMessagesOldestFirst(merged);
  const anchored = new Map<string, OptimisticChatMessage[]>();
  const beforeTranscript: OptimisticChatMessage[] = [];
  for (const optimisticMessage of remaining) {
    if (!optimisticMessage.precedingMessageId) {
      beforeTranscript.push(optimisticMessage);
      continue;
    }
    const group = anchored.get(optimisticMessage.precedingMessageId) ?? [];
    group.push(optimisticMessage);
    anchored.set(optimisticMessage.precedingMessageId, group);
  }
  const result: Message[] = [...beforeTranscript];
  for (const message of sortMessagesOldestFirst(merged)) {
    result.push(message);
    const after = anchored.get(message.id);
    if (after) result.push(...after);
  }
  const placed = new Set(result.map((message) => message.id));
  result.push(...remaining.filter((message) => !placed.has(message.id)));
  return result;
}
