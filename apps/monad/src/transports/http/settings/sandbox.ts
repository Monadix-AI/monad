import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createSandboxSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.sandboxSettings;

  // Settings surface consumed only by the web UI — no JSON-RPC counterpart (see route-table-parity).
  return new Elysia({ tags: ['http-only'] })
    .get('/sandbox', async () => handlers.sandbox.getSandboxSettings(), {
      response: c.get.response,
      detail: { summary: 'Get system-level sandbox defaults + the global ceiling' }
    })
    .put('/sandbox', async ({ body }) => handlers.sandbox.setSandboxSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update system-level sandbox defaults + the global ceiling' }
    });
}
