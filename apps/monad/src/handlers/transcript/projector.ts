import type { Event, MessageId, ProjectId, SessionId } from '@monad/protocol';
import type { EventBus } from '@/services/event-bus.ts';
import type { RoundCache } from '@/services/round-cache.ts';
import type { Store } from '@/store/db/index.ts';

import { newId } from '@monad/protocol';

// `insertAssistantMessage`/`completeAssistantMessage` are also called with a Workplace Project's own
// id (services/native-agent/project.ts's `ask()`, for a project's Q&A wall) — a real, still-open
// class-C usage per the Track B P6b id collapse (see the SessionOrProject TODO in
// apps/monad/src/handlers/session/context.ts). `Event.sessionId` is strictly `SessionId` on the wire,
// so the project-id case casts.
type TranscriptTargetId = SessionId | ProjectId;

export function createTranscriptProjector(deps: { store: Store; bus: EventBus; cache: RoundCache }) {
  function publish(event: Event): void {
    deps.cache.append(event);
    deps.bus.publish(event);
    deps.store.appendEvents([event]);
    deps.cache.retire(event.sessionId);
  }

  return {
    insertAssistantMessage(args: {
      sessionId: TranscriptTargetId;
      agentName: string;
      text: string;
      data?: Record<string, unknown>;
      includeInContext?: boolean;
      streamStatus?: 'streaming' | 'complete';
    }): { messageId: MessageId } {
      const messageId = newId('msg');
      deps.store.insertMessage(messageId, args.sessionId, args.text, new Date().toISOString(), 'assistant', {
        data: { agentName: args.agentName, ...args.data },
        includeInContext: args.includeInContext,
        streamStatus: args.streamStatus
      });
      publish({
        id: newId('evt'),
        sessionId: args.sessionId as SessionId,
        type: 'agent.message',
        actorAgentId: null,
        payload: { messageId, agentName: args.agentName, text: args.text },
        at: new Date().toISOString()
      });
      return { messageId };
    },

    completeAssistantMessage(args: {
      sessionId: TranscriptTargetId;
      messageId: MessageId;
      agentName: string;
      text: string;
    }): void {
      deps.store.setGenStatus(args.sessionId, args.messageId, 'complete', new Date().toISOString(), {
        text: args.text
      });
      publish({
        id: newId('evt'),
        sessionId: args.sessionId as SessionId,
        type: 'agent.message',
        actorAgentId: null,
        payload: { messageId: args.messageId, agentName: args.agentName, text: args.text },
        at: new Date().toISOString()
      });
    }
  };
}
