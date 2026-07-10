import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createInboxController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const contracts = daemonHttpContract.inbox;
  return new Elysia({ tags: ['http-only'] }).get(
    '/inbox/mentions',
    ({ query }) => ({
      items: handlers._nativeAgentStore.listMentionInbox(query.limit)
    }),
    {
      query: contracts.mentions.query,
      response: contracts.mentions.response,
      detail: {
        summary: 'List mention inbox items',
        description: 'Returns unconsumed project messages routed to managed session members.'
      }
    }
  );
}
