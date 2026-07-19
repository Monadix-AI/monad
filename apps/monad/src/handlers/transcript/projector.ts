import type { MessageId, TranscriptTargetId } from '@monad/protocol';
import type { MessageIngress } from '#/services/messages/types.ts';

import { messageIdempotencyKey } from '#/services/messages/ingress.ts';

export function createTranscriptProjector(deps: { messageIngress: MessageIngress }) {
  return {
    insertAssistantMessage(args: {
      sessionId: TranscriptTargetId;
      agentName: string;
      text: string;
      data?: Record<string, unknown>;
      includeInContext?: boolean;
      streamStatus?: 'streaming' | 'complete';
    }): Promise<{ messageId: MessageId }> {
      const command = {
        transcriptTargetId: args.sessionId,
        idempotencyKey: messageIdempotencyKey('transcript-projector', args.sessionId, crypto.randomUUID()),
        producer: { kind: 'system' as const, subsystem: 'transcript-projector' },
        role: 'assistant' as const,
        type: 'text' as const,
        text: args.text,
        data: { agentName: args.agentName, ...args.data },
        includeInContext: args.includeInContext
      };
      const create =
        args.streamStatus === 'streaming' ? deps.messageIngress.begin(command) : deps.messageIngress.deliver(command);
      return create.then((message) => ({ messageId: message.id }));
    },

    completeAssistantMessage(args: {
      sessionId: TranscriptTargetId;
      messageId: MessageId;
      agentName: string;
      text: string;
    }): Promise<void> {
      return deps.messageIngress
        .settle({
          transcriptTargetId: args.sessionId,
          messageId: args.messageId,
          idempotencyKey: messageIdempotencyKey('transcript-projector', args.messageId, 'complete'),
          producer: { kind: 'system', subsystem: 'transcript-projector' },
          text: args.text
        })
        .then(() => {});
    }
  };
}
