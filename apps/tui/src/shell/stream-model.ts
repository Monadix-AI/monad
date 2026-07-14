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
