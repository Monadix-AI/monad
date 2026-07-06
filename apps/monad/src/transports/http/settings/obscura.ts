import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createObscuraSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.obscuraSettings;

  // Settings surface consumed only by the web UI — no JSON-RPC counterpart (see route-table-parity).
  return new Elysia({ tags: ['http-only'] })
    .get('/obscura', async () => handlers.obscura.getObscura(), {
      response: c.get.response,
      detail: {
        summary: 'Get Obscura status',
        description: 'Returns installation and connection status for the Obscura headless browser MCP.'
      }
    })
    .put('/obscura', async ({ body }) => handlers.obscura.setObscura(body), {
      body: c.set.body,
      response: c.set.response,
      detail: {
        summary: 'Enable or disable Obscura',
        description:
          'Downloads the binary if not present, then hot-loads the MCP server. Disable closes the connection (tools removed from registry on next restart).'
      }
    });
}
