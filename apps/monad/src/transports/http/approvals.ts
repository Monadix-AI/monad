import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

// Remembered approval rules: list, revoke one, or bulk-clear. Backs `monad approvals` + the web
// "authorized" panel. Wire schemas come from @monad/protocol (single source of truth).
export function createApprovalsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const list = daemonHttpContract.approvals.list;
  const revoke = daemonHttpContract.approvals.revoke;
  const clear = daemonHttpContract.approvals.clear;
  return new Elysia()
    .get('/approvals', async ({ query }) => handlers.oversight.list(query), {
      query: list.query,
      response: list.response,
      detail: {
        summary: 'List remembered approval rules',
        description: 'Persisted (global + agent) plus the given session.'
      }
    })
    .post('/approvals/revoke', async ({ body }) => handlers.oversight.revoke(body), {
      body: revoke.body,
      response: revoke.response,
      detail: { summary: 'Revoke one approval rule by id' }
    })
    .post('/approvals/clear', async ({ body }) => handlers.oversight.clear(body), {
      body: clear.body,
      response: clear.response,
      detail: { summary: 'Bulk-clear approval rules', description: 'Optional scope/agent filter.' }
    });
}
