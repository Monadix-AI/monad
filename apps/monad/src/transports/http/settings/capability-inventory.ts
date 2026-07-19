import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createCapabilityInventorySettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.capabilityInventory;

  return new Elysia({ tags: ['settings'] })
    .get('/capability-inventory', async () => handlers.capabilityInventory.list(), {
      response: c.list.response,
      detail: {
        tags: ['http-only'],
        summary: 'List discovered capabilities',
        description: 'Read-only inventory of skills and MCP servers discovered in Monad and MeshAgent locations.'
      }
    })
    .post('/capability-inventory/open-location', async ({ body }) => handlers.capabilityInventory.openLocation(body), {
      body: c.openLocation.body,
      response: c.openLocation.response,
      detail: {
        tags: ['http-only'],
        summary: 'Open capability inventory location',
        description: 'Open the product-level local folder for a known capability inventory root.'
      }
    });
}
