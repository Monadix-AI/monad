import type { ChatMessage, MessageRepo } from './types.ts';

export class InMemoryMessageRepo implements MessageRepo {
  private readonly bySession = new Map<string, ChatMessage[]>();

  list(sessionId: string): ChatMessage[] {
    return this.bySession.get(sessionId) ?? [];
  }

  append(message: ChatMessage): void {
    const list = this.bySession.get(message.sessionId) ?? [];
    list.push(message);
    this.bySession.set(message.sessionId, list);
  }
}
