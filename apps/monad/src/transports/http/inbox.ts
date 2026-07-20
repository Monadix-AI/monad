import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createInboxController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const contracts = daemonHttpContract.inbox;
  return new Elysia({ tags: ['http-only'] })
    .get('/inbox/items', ({ query }) => handlers._nativeAgentStore.listOperatorInbox(query), {
      query: contracts.items.query,
      response: contracts.items.response,
      detail: { summary: 'List operator Inbox items' }
    })
    .get('/inbox/summary', () => handlers._nativeAgentStore.operatorInboxSummary(), {
      response: contracts.summary.response,
      detail: { summary: 'Get operator Inbox badge counts' }
    })
    .post('/inbox/read', ({ body }) => handlers._nativeAgentStore.markOperatorInboxRead(body.itemKeys), {
      body: contracts.read.body,
      response: contracts.read.response,
      detail: { summary: 'Mark actually visible Inbox items as read' }
    })
    .get(
      '/inbox/mentions',
      ({ query }) => ({
        items: handlers._nativeAgentStore.listMentionInbox(query.limit)
      }),
      {
        query: contracts.mentions.query,
        response: contracts.mentions.response,
        detail: {
          summary: 'List mention inbox items',
          description: 'Returns the legacy mention and unresolved approval projection.'
        }
      }
    );
}
