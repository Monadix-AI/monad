import type { Event, MessageId, TranscriptTargetId } from '@monad/protocol';
import type { EventBus } from '@/services/event-bus.ts';
import type { RoundCache } from '@/services/round-cache.ts';
import type { Store } from '@/store/db/index.ts';

import { newId } from '@monad/protocol';

export function createTranscriptProjector(deps: { store: Store; bus: EventBus; cache: RoundCache }) {
  function publish(event: Event): void {
    deps.cache.append(event);
    deps.bus.publish(event);
    deps.store.appendEvents([event]);
    deps.cache.retire(event.transcriptTargetId);
  }

  return {
    insertAssistantMessage(args: {
      transcriptTargetId: TranscriptTargetId;
      agentName: string;
      text: string;
      data?: Record<string, unknown>;
      includeInContext?: boolean;
      streamStatus?: 'streaming' | 'complete';
    }): { messageId: MessageId } {
      const messageId = newId('msg');
      deps.store.insertMessage(messageId, args.transcriptTargetId, args.text, new Date().toISOString(), 'assistant', {
        data: { agentName: args.agentName, ...args.data },
        includeInContext: args.includeInContext,
        streamStatus: args.streamStatus
      });
      publish({
        id: newId('evt'),
        transcriptTargetId: args.transcriptTargetId,
        type: 'agent.message',
        actorAgentId: null,
        payload: { messageId, agentName: args.agentName, text: args.text },
        at: new Date().toISOString()
      });
      return { messageId };
    },

    completeAssistantMessage(args: {
      transcriptTargetId: TranscriptTargetId;
      messageId: MessageId;
      agentName: string;
      text: string;
    }): void {
      deps.store.setGenStatus(args.transcriptTargetId, args.messageId, 'complete', new Date().toISOString(), {
        text: args.text
      });
      publish({
        id: newId('evt'),
        transcriptTargetId: args.transcriptTargetId,
        type: 'agent.message',
        actorAgentId: null,
        payload: { messageId: args.messageId, agentName: args.agentName, text: args.text },
        at: new Date().toISOString()
      });
    }
  };
}
