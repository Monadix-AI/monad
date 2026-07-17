import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { DAEMON_RESTART_EXIT_CODE, daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

import { shutdownBus } from '#/infra/shutdown-bus.ts';

interface DeveloperSettingsControllerOptions {
  restartDaemon?: () => void;
  schedule?: (task: () => void) => void;
}

function scheduleSoon(task: () => void): void {
  setTimeout(task, 50);
}

export function createDeveloperSettingsController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  options: DeveloperSettingsControllerOptions = {}
) {
  const c = daemonHttpContract.developerSettings;
  const restartDaemon = options.restartDaemon ?? (() => shutdownBus.trigger({ exitCode: DAEMON_RESTART_EXIT_CODE }));
  const schedule = options.schedule ?? scheduleSoon;

  return new Elysia({ tags: ['http-only'] })
    .get('/developer', async () => handlers.developer.getDeveloperSettings(), {
      response: c.get.response,
      detail: { summary: 'Get developer logging settings' }
    })
    .put(
      '/developer',
      async ({ body }) => {
        const settings = await handlers.developer.setDeveloperSettings(body);
        schedule(restartDaemon);
        return settings;
      },
      {
        body: c.set.body,
        response: c.set.response,
        detail: { summary: 'Update developer logging settings and restart the daemon' }
      }
    );
}
