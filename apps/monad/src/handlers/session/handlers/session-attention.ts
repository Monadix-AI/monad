import type { ConsumeSessionAttentionRequest, SessionId } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';

import { makeEvent } from '#/services/event-bus.ts';

export function createSessionAttentionHandlers(ctx: SessionContext) {
  const {
    deps: { store, bus }
  } = ctx;
  return {
    listAttention({ sessionIds }: { sessionIds: SessionId[] }) {
      return { summaries: store.listSessionAttention(sessionIds) };
    },
    consumeAttention({ id, itemKeys, cause }: { id: SessionId } & ConsumeSessionAttentionRequest) {
      ctx.requireSession(id);
      const result = store.consumeSessionAttention(id, itemKeys, cause, new Date().toISOString());
      if (result.consumedItemKeys.length > 0) {
        bus.publish(makeEvent(id, 'session.attention.updated', { transcriptTargetId: id }));
      }
      return result;
    }
  };
}
