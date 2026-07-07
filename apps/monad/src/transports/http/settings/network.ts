import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createNetworkSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.networkSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/network', async () => handlers.network.getNetworkSettings(), {
      response: c.get.response,
      detail: { summary: 'Get network and remote access settings' }
    })
    .put('/network', async ({ body }) => handlers.network.setNetworkSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update network and remote access settings' }
    })
    .post('/network/probe', async ({ body }) => handlers.network.probeNetwork(body), {
      body: c.probe.body,
      response: c.probe.response,
      detail: { summary: 'Probe a daemon network URL from the daemon host' }
    });
}
