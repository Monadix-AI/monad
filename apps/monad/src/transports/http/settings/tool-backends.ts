import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createToolBackendsSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.toolBackendsSettings;

  // Settings surface consumed only by the web UI — no JSON-RPC counterpart (see route-table-parity).
  return new Elysia({ tags: ['http-only'] })
    .get('/tool-backends', async () => handlers.toolBackends.getToolBackends(), {
      response: c.get.response,
      detail: { summary: 'Get built-in tool backend configuration (web search, email)' }
    })
    .put('/tool-backends', async ({ body }) => handlers.toolBackends.setToolBackends(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update built-in tool backend configuration' }
    })
    .post('/tool-backends/init-docker', async () => handlers.toolBackends.initDockerBackend(), {
      response: c.initDocker.response,
      detail: { summary: 'Pull the configured Docker image for code execution' }
    });
}
