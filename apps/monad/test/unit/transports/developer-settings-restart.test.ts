import { expect, test } from 'bun:test';

import { createDeveloperSettingsController } from '#/transports/http/settings/developer.ts';

test('updating Developer Mode schedules a daemon restart after persisting the setting', async () => {
  const events: string[] = [];
  const handlers = {
    developer: {
      async setDeveloperSettings(request: { developerMode: boolean }) {
        events.push(`persist:${request.developerMode}`);
        return { developerMode: request.developerMode, logsDir: '/tmp/logs' };
      },
      async getDeveloperSettings() {
        return { developerMode: false, logsDir: '/tmp/logs' };
      }
    }
  } as Parameters<typeof createDeveloperSettingsController>[0];
  const app = createDeveloperSettingsController(handlers, {
    restartDaemon: () => events.push('restart'),
    schedule: (task) => task()
  });

  const response = await app.handle(
    new Request('http://localhost/developer', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ developerMode: true })
    })
  );

  expect({ body: await response.json(), events, status: response.status }).toEqual({
    body: { developerMode: true, logsDir: '/tmp/logs' },
    events: ['persist:true', 'restart'],
    status: 200
  });
});
