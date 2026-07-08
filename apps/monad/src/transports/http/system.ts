import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

import { isLoopbackPeer } from '#/transports/http/browser-guard.ts';

export function createSystemController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const pickDirectoryContract = daemonHttpContract.system.pickDirectory;
  const upgradeGetContract = daemonHttpContract.system.upgradeGet;
  const upgradeStartContract = daemonHttpContract.system.upgradeStart;
  return new Elysia({ tags: ['http-only'] })
    .onBeforeHandle(({ request, server, set }) => {
      // The picker spawns a host process and drives the local desktop — never serve it to a remote
      // peer, even one holding a valid remote-access token. Unix socket (no peer IP) and loopback only.
      if (!isLoopbackPeer(server?.requestIP(request)?.address)) {
        set.status = 403;
        return { error: 'forbidden' };
      }
    })
    .get('/system/upgrade', async () => handlers.system.getUpgradeStatus(), {
      response: upgradeGetContract.response,
      detail: { summary: 'Get Monad upgrade status' }
    })
    .post(
      '/system/upgrade',
      async ({ set }) => {
        set.status = 202;
        return handlers.system.startUpgrade();
      },
      {
        response: upgradeStartContract.response,
        detail: { summary: 'Start a Monad upgrade' }
      }
    )
    .post('/system/pick-directory', async ({ body }) => handlers.system.pickDirectory(body), {
      body: pickDirectoryContract.body,
      response: pickDirectoryContract.response,
      detail: {
        summary: 'Open a native folder picker on the daemon host',
        description: 'Returns the chosen absolute path, or path:null when the user cancelled or no picker is available.'
      }
    });
}
