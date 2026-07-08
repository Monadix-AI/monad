import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { daemonHttpContract } from '@monad/protocol';
import { Elysia } from 'elysia';

export function createUserProfileSettingsController(handlers: ReturnType<typeof createDaemonHandlers>) {
  const c = daemonHttpContract.userProfileSettings;

  return new Elysia({ tags: ['http-only'] })
    .get('/profile', async () => handlers.profile.getProfileSettings(), {
      response: c.get.response,
      detail: { summary: 'Get user profile settings' }
    })
    .put('/profile', async ({ body }) => handlers.profile.setProfileSettings(body), {
      body: c.set.body,
      response: c.set.response,
      detail: { summary: 'Update user profile settings' }
    });
}
