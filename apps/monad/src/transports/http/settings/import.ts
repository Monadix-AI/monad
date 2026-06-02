import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createSettingsImportController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.settingsImport;

  return new Elysia({ tags: ['http-only'] })
    .post('/import/preview', async ({ body }) => handlers.settingsImport.preview(body), {
      body: c.preview.body,
      response: c.preview.response,
      detail: {
        summary: 'Preview external settings import',
        description: 'Parses a user-provided local file or directory and returns importable Monad settings.'
      }
    })
    .post('/import/apply', async ({ body }) => handlers.settingsImport.apply(body), {
      body: c.apply.body,
      response: c.apply.response,
      detail: {
        summary: 'Apply external settings import',
        description: 'Applies selected preview item ids from a user-provided local file or directory.'
      }
    });
}
