import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createToolsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const contract = daemonHttpContract.tools.approve;
  return new Elysia().post('/tools/approve', async ({ body }) => handlers.oversight.approve(body), {
    body: contract.body,
    response: contract.response,
    detail: {
      summary: 'Approve or deny a high-risk tool call',
      description: 'Resolves a pending tool.approval_requested. ok:false → unknown/expired request id.'
    }
  });
}
