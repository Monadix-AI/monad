import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createCommandsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  return new Elysia().get('/commands', async ({ query }) => handlers.commands.list(query), {
    query: daemonHttpContract.commands.list.query,
    response: daemonHttpContract.commands.list.response,
    detail: {
      summary: 'List available slash commands',
      description: 'Built-in + atom commands + user-invocable skills — the unified set every client shows.'
    }
  });
}
