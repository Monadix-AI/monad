import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/environment';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createDeveloperModule } from '#/handlers/settings/developer/index.ts';
import { LogCleanupPreviewBusyError } from '#/services/log-maintenance.ts';
import { createDeveloperSettingsController } from '#/transports/http/settings/developer.ts';
import { makeTestPaths, stubConfigAccess } from '../../helpers.ts';

const settings = {
  developerMode: false,
  logsDir: '/tmp/logs',
  logs: { autoCleanup: { enabled: true, retentionDays: 14 } }
};

function controllerHandlers(overrides?: {
  get?: () => Promise<typeof settings>;
  set?: (request: {
    developerMode?: boolean;
    logs?: { autoCleanup?: { enabled: boolean; retentionDays: number } };
  }) => Promise<typeof settings>;
  preview?: (policy: { enabled: boolean; retentionDays: number }) => Promise<{ files: number; bytes: number }>;
  clear?: () => Promise<{ filesCleared: number; filesFailed: number; bytesFreed: number }>;
}) {
  return {
    developer: {
      getDeveloperSettings: overrides?.get ?? (async () => settings),
      setDeveloperSettings: overrides?.set ?? (async () => settings),
      previewLogCleanup: overrides?.preview ?? (async () => ({ files: 0, bytes: 0 })),
      clearLogs: overrides?.clear ?? (async () => ({ filesCleared: 0, filesFailed: 0, bytesFreed: 0 }))
    }
  } as Parameters<typeof createDeveloperSettingsController>[0];
}

test('updating Developer Mode schedules a daemon restart after persisting the setting', async () => {
  const events: string[] = [];
  const handlers = {
    developer: {
      async setDeveloperSettings(request: { developerMode: boolean }) {
        events.push(`persist:${request.developerMode}`);
        return { ...settings, developerMode: request.developerMode };
      },
      async getDeveloperSettings() {
        return settings;
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
    body: { ...settings, developerMode: true },
    events: ['persist:true', 'restart'],
    status: 200
  });
});

test('updating only the log policy persists without restarting the daemon', async () => {
  const events: string[] = [];
  const app = createDeveloperSettingsController(
    controllerHandlers({
      set: async (request) => {
        events.push(`persist:${request.logs?.autoCleanup?.retentionDays}`);
        return { ...settings, logs: { autoCleanup: { enabled: true, retentionDays: 7 } } };
      }
    }),
    { restartDaemon: () => events.push('restart'), schedule: (task) => task() }
  );

  const response = await app.handle(
    new Request('http://localhost/developer', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logs: { autoCleanup: { enabled: true, retentionDays: 7 } } })
    })
  );

  expect({ body: await response.json(), events, status: response.status }).toEqual({
    body: { ...settings, logs: { autoCleanup: { enabled: true, retentionDays: 7 } } },
    events: ['persist:7'],
    status: 200
  });
});

test('developer settings handler persists and returns the accepted log policy', async () => {
  const base = '/tmp/monad-log-policy-handler';
  const cfg = createDefaultConfig('test');
  cfg.developerMode = false;
  const previewPolicies: Array<{ enabled: boolean; retentionDays: number }> = [];
  const config = stubConfigAccess(cfg);
  const paths = makeTestPaths(base);
  const module = createDeveloperModule(paths, config, {
    clearAll: async () => ({ filesCleared: 0, filesFailed: 0, bytesFreed: 0 }),
    preview: async (policy) => {
      previewPolicies.push(policy);
      return { files: 2, bytes: 42 };
    }
  });

  const updated = await module.setDeveloperSettings({
    logs: { autoCleanup: { enabled: true, retentionDays: 7 } }
  });
  const preview = await module.previewLogCleanup({ enabled: true, retentionDays: 7 });

  expect({ persisted: config.get().cfg.logs.autoCleanup, preview, previewPolicies, updated }).toEqual({
    persisted: { enabled: true, retentionDays: 7 },
    preview: { files: 2, bytes: 42 },
    previewPolicies: [{ enabled: true, retentionDays: 7 }],
    updated: {
      developerMode: false,
      logsDir: paths.logs,
      logs: { autoCleanup: { enabled: true, retentionDays: 7 } }
    }
  });
});

test('HTTP validation rejects invalid or unknown log policy fields before invoking handlers', async () => {
  const previewPolicies: Array<{ enabled: boolean; retentionDays: number }> = [];
  const app = createDeveloperSettingsController(
    controllerHandlers({
      preview: async (policy) => {
        previewPolicies.push(policy);
        return { files: 0, bytes: 0 };
      }
    })
  );
  const requests = [
    { enabled: true, retentionDays: 0 },
    { enabled: true, retentionDays: 31 },
    { enabled: true, retentionDays: 1.5 },
    { enabled: true, retentionDays: 14, path: '/private/log' }
  ];
  const responses = await Promise.all(
    requests.map((body) =>
      app.handle(
        new Request('http://localhost/developer/logs/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      )
    )
  );

  expect({ previewPolicies, statuses: responses.map((response) => response.status) }).toEqual({
    previewPolicies: [],
    statuses: [422, 422, 422, 422]
  });
});

test('preview returns aggregate impact without requiring Developer Mode', async () => {
  const policies: Array<{ enabled: boolean; retentionDays: number }> = [];
  const app = createDeveloperSettingsController(
    controllerHandlers({
      preview: async (policy) => {
        policies.push(policy);
        return { files: 3, bytes: 42 };
      }
    })
  );

  const response = await app.handle(
    new Request('http://localhost/developer/logs/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, retentionDays: 7 })
    })
  );

  expect({ body: await response.json(), policies, status: response.status }).toEqual({
    body: { files: 3, bytes: 42 },
    policies: [{ enabled: true, retentionDays: 7 }],
    status: 200
  });
});

test('preview admission rejection returns 429 with a two-second retry interval', async () => {
  const app = createDeveloperSettingsController(
    controllerHandlers({
      preview: async () => {
        throw new LogCleanupPreviewBusyError();
      }
    })
  );

  const response = await app.handle(
    new Request('http://localhost/developer/logs/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, retentionDays: 7 })
    })
  );

  expect({
    body: await response.json(),
    retryAfter: response.headers.get('retry-after'),
    status: response.status
  }).toEqual({
    body: { error: 'Log cleanup preview is temporarily unavailable', code: 'RATE_LIMITED' },
    retryAfter: '2',
    status: 429
  });
});

test('clear returns only aggregate cleanup accounting', async () => {
  const app = createDeveloperSettingsController(
    controllerHandlers({ clear: async () => ({ filesCleared: 2, filesFailed: 1, bytesFreed: 42 }) })
  );

  const response = await app.handle(new Request('http://localhost/developer/logs', { method: 'DELETE' }));

  expect({ body: await response.json(), status: response.status }).toEqual({
    body: { filesCleared: 2, filesFailed: 1, bytesFreed: 42 },
    status: 200
  });
});

test('clear invokes the lifecycle service when Developer Mode is enabled', async () => {
  const cfg = createDefaultConfig('test');
  cfg.developerMode = true;
  const clearCalls: string[] = [];
  const module = createDeveloperModule(makeTestPaths('/tmp/monad-log-handler'), stubConfigAccess(cfg), {
    clearAll: async () => {
      clearCalls.push('clear');
      return { filesCleared: 2, filesFailed: 1, bytesFreed: 42 };
    },
    preview: async () => ({ files: 0, bytes: 0 })
  });
  const result = await module.clearLogs();

  expect({ clearCalls, result }).toEqual({
    clearCalls: ['clear'],
    result: { filesCleared: 2, filesFailed: 1, bytesFreed: 42 }
  });
});

test('clear is rejected by the handler when Developer Mode is disabled', async () => {
  const cfg = createDefaultConfig('test');
  cfg.developerMode = false;
  const clearCalls: string[] = [];
  const module = createDeveloperModule(makeTestPaths('/tmp/monad-log-handler'), stubConfigAccess(cfg), {
    clearAll: async () => {
      clearCalls.push('clear');
      return { filesCleared: 1, filesFailed: 0, bytesFreed: 42 };
    },
    preview: async () => ({ files: 0, bytes: 0 })
  });

  try {
    await module.clearLogs();
    throw new Error('expected clearLogs to reject');
  } catch (error) {
    expect({ clearCalls, error }).toEqual({
      clearCalls: [],
      error: new HandlerError('forbidden', 'Developer Mode must be enabled to clear logs')
    });
  }
});
