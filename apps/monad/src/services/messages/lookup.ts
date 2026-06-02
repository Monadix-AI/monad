import type { ChatMessage, MeshSessionId, MessageId, SessionId, TranscriptTargetId } from '@monad/protocol';
import type { Store } from '#/store/db/index.ts';

export type MessageReadActor =
  | { kind: 'user-client' }
  | { kind: 'daemon-agent'; sessionId: SessionId }
  | { kind: 'managed-agent'; meshSessionId: MeshSessionId };

interface MessageLookupAuthorization {
  transcriptTargetId: TranscriptTargetId;
  messageId: MessageId;
  actor: MessageReadActor;
}

export type MessageLookupResult = { status: 'found'; message: ChatMessage } | { status: 'not-found' };

export class MessageLookup {
  constructor(
    private readonly store: Pick<Store, 'getMessage'>,
    private readonly authorize: (input: MessageLookupAuthorization) => boolean
  ) {}

  get(input: {
    transcriptTargetId: TranscriptTargetId;
    messageId: MessageId;
    actor: MessageReadActor;
  }): MessageLookupResult {
    if (!this.authorize(input)) return { status: 'not-found' };
    const message = this.store.getMessage(input.transcriptTargetId, input.messageId);
    if (!message?.active) return { status: 'not-found' };
    return { status: 'found', message };
  }

  getMany(input: {
    transcriptTargetId: TranscriptTargetId;
    messageIds: readonly MessageId[];
    actor: MessageReadActor;
  }): ChatMessage[] {
    return [...new Set(input.messageIds)].slice(0, 100).flatMap((messageId) => {
      const result = this.get({ transcriptTargetId: input.transcriptTargetId, messageId, actor: input.actor });
      return result.status === 'found' ? [result.message] : [];
    });
  }
}
