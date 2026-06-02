import type { MessageId } from '@monad/protocol';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { MessageLookup } from '#/services/messages/lookup.ts';
import type { ToolModule } from './contract.ts';

import { messageIdSchema, sessionIdSchema } from '@monad/protocol';
import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';

export function createMessageRetrieveTool(lookup: MessageLookup): Tool<{ messageId: MessageId }> {
  return {
    name: 'message_retrieve',
    description: 'Retrieve one active canonical message from the current transcript by id.',
    scopes: [{ resource: 'message:read' }],
    inputSchema: z.object({ messageId: messageIdSchema }),
    run: async ({ messageId }, ctx) => {
      const sessionId = sessionIdSchema.parse(ctx.sessionId);
      return toolResult(
        lookup.get({
          transcriptTargetId: sessionId,
          messageId,
          actor: { kind: 'daemon-agent', sessionId }
        })
      );
    }
  };
}

export const register: ToolModule<{ lookup: MessageLookup }> = ({ lookup }) => [createMessageRetrieveTool(lookup)];
