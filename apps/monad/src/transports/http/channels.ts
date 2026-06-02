import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { sendMessageRequestSchema, sendMessageResponseSchema, sessionIdSchema } from '@monad/protocol';
import { Elysia } from 'elysia';
import { z } from 'zod';

const channelParams = z.object({ id: sessionIdSchema });

export function createChannelsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia({ tags: ['http-only'] })
    .post(
      '/projects/:id/messages',
      async ({ params, body }) => handlers.session.sendProjectMessage({ sessionId: params.id, text: body.text }),
      {
        params: channelParams,
        body: sendMessageRequestSchema.pick({ text: true }),
        response: { 200: sendMessageResponseSchema },
        detail: {
          summary: 'Send project message',
          description: 'Routes a workplace project message according to the project host and mention rules.'
        }
      }
    )
    .post(
      '/channels/:id/messages',
      async ({ params, body }) => handlers.session.sendChannelMessage({ sessionId: params.id, text: body.text }),
      {
        params: channelParams,
        body: sendMessageRequestSchema.pick({ text: true }),
        response: { 200: sendMessageResponseSchema },
        detail: {
          summary: 'Send legacy channel message',
          description: 'Compatibility alias for project message routing.'
        }
      }
    );
}
