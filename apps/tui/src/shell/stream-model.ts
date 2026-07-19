import type { ContextUsagePayload, MemorySuggestionPayload, UIItem } from '@monad/protocol';

import { memorySuggestionPayloadSchema } from '@monad/protocol';

export interface StreamTranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
}

export interface StreamCursor {
  length: number;
  messageId: string | null;
}

export interface TuiMemorySuggestion extends MemorySuggestionPayload {
  id: string;
}

export interface TuiUiProjection {
  messages: StreamTranscriptMessage[];
  usage?: ContextUsagePayload;
  memorySuggestion?: TuiMemorySuggestion;
  handoffText?: string;
}

export function projectUiItems(items: readonly UIItem[]): TuiUiProjection {
  const messages: StreamTranscriptMessage[] = [];
  let usage: ContextUsagePayload | undefined;
  let memorySuggestion: TuiMemorySuggestion | undefined;
  let handoffText: string | undefined;

  for (const item of items) {
    if (item.kind === 'message') {
      messages.push({
        id: item.id,
        role: item.role,
        text: item.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
        ...(item.status === 'streaming' ? { streaming: true } : {})
      });
      continue;
    }
    if (item.kind === 'context') {
      usage = item.usage;
      continue;
    }
    if (item.kind === 'custom' && item.name === 'memory.suggestion') {
      const parsed = memorySuggestionPayloadSchema.safeParse(item.data);
      if (parsed.success) memorySuggestion = { id: item.id, ...parsed.data };
      continue;
    }
    if (item.kind === 'system' && item.id.startsWith('context-handoff:')) handoffText = item.text;
  }

  return {
    messages,
    ...(usage ? { usage } : {}),
    ...(memorySuggestion ? { memorySuggestion } : {}),
    ...(handoffText ? { handoffText } : {})
  };
}

export function settledAssistantMessages<T extends StreamTranscriptMessage>(messages: T[]): T[] {
  return messages.filter((message) => message.role === 'assistant' && !message.streaming);
}

export function advanceStreamCursor<T extends StreamTranscriptMessage>(
  previous: StreamCursor,
  message: T | undefined
): { cursor: StreamCursor; delta: string } {
  if (!message) return { cursor: { length: 0, messageId: null }, delta: '' };
  const start = previous.messageId === message.id ? previous.length : 0;
  return {
    cursor: { length: message.text.length, messageId: message.id },
    delta: message.text.slice(start)
  };
}
