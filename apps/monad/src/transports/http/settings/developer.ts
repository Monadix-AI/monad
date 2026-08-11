import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { DAEMON_RESTART_EXIT_CODE, daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

import { shutdownBus } from '#/infra/shutdown-bus.ts';
import { LogCleanupPreviewBusyError } from '#/services/log-maintenance.ts';

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
        const previous = await handlers.developer.getDeveloperSettings();
        const settings = await handlers.developer.setDeveloperSettings(body);
        if (body.developerMode !== undefined && settings.developerMode !== previous.developerMode) {
          schedule(restartDaemon);
        }
        return settings;
      },
      {
        body: c.set.body,
        response: c.set.response,
        detail: { summary: 'Update developer logging settings' }
      }
    )
    .post(
      '/developer/logs/preview',
      async ({ body, set }) => {
        try {
          return await handlers.developer.previewLogCleanup(body);
        } catch (error) {
          if (!(error instanceof LogCleanupPreviewBusyError)) throw error;
          set.status = 429;
          set.headers['retry-after'] = String(error.retryAfterSeconds);
          return { error: error.message, code: 'RATE_LIMITED' };
        }
      },
      {
        body: c.previewLogCleanup.body,
        response: c.previewLogCleanup.response,
        detail: { summary: 'Preview automatic log cleanup impact' }
      }
    )
    .delete('/developer/logs', async () => handlers.developer.clearLogs(), {
      response: c.clearLogs.response,
      detail: { summary: 'Clear all managed logs' }
    })
    .get('/developer/live-events', async () => handlers.developer.listLiveEvents(), {
      response: c.listLiveEvents.response,
      detail: { summary: 'List saved native CLI live event captures' }
    })
    .get(
      '/developer/live-events/:meshSessionId/:observationEpoch',
      async ({ params, query }) => handlers.developer.getLiveEventFrames({ ...params, query }),
      {
        params: c.getLiveEventFrames.params,
        query: c.getLiveEventFrames.query,
        response: c.getLiveEventFrames.response,
        detail: { summary: 'Read saved native CLI live event frames' }
      }
    );
}
