import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createSkillsSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.skillsSettings;

  return new Elysia()
    .get('/skills', async () => handlers.skillsSettings.getSkillsSettings(), {
      response: c.get.response,
      detail: { summary: 'Get global skill context settings' }
    })
    .put('/skills', async ({ body }) => handlers.skillsSettings.setSkillsSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update global skill context settings' }
    });
}
