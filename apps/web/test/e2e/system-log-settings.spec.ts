import { expect, type Page, test } from '@playwright/test';

import { API_ROUTE_PATTERN } from './api-route-pattern';

type LogPolicy = { enabled: boolean; retentionDays: number };
type DeveloperResponse = { status?: 500; waitForRelease?: true };
type DeveloperUpdateResponse = { status: 500 };
type PreviewResponse =
  | { files: number; bytes: number }
  | { status: 429 }
  | { networkFailure: true }
  | { waitForRelease: true; files: number; bytes: number };

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers,
    status
  };
}

async function installSystemLogSettingsApiMock(
  page: Page,
  options: {
    clearResult?: { filesCleared: number; filesFailed: number; bytesFreed: number };
    developerResponses?: DeveloperResponse[];
    developerMode?: boolean;
    policy?: LogPolicy;
    previewResponses?: PreviewResponse[];
  } = {}
) {
  let developerMode = options.developerMode ?? false;
  let policy = options.policy ?? { enabled: true, retentionDays: 14 };
  const previews: LogPolicy[] = [];
  const updates: unknown[] = [];
  let clearCalls = 0;
  let developerGets = 0;
  let releaseDeveloperGet: (() => void) | undefined;
  const developerResponses = [...(options.developerResponses ?? [])];
  const developerUpdateResponses: DeveloperUpdateResponse[] = [];
  const previewResponses = [...(options.previewResponses ?? [])];
  let releasePreview: (() => void) | undefined;

  await page.route(API_ROUTE_PATTERN, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/') || url.pathname === '/health')) {
      return route.continue();
    }

    const path = url.pathname.replace('/api/v1', '/v1').replace('/api/health', '/health');
    const method = request.method();

    if (method === 'GET' && path === '/health') {
      return route.fulfill(json({ status: 'ok', version: '0.1.1', latestVersion: '0.1.1' }));
    }
    if (method === 'GET' && path === '/v1/init/status') {
      return route.fulfill(json({ initialized: true, missing: [], homePath: 'home' }));
    }
    if (method === 'GET' && path === '/v1/sessions') {
      return route.fulfill(json({ sessions: [], total: 0, limit: 50, offset: 0 }));
    }
    if (method === 'GET' && path === '/v1/commands') return route.fulfill(json({ commands: [] }));
    if (method === 'GET' && (path === '/v1/mesh/runtimes' || path === '/v1/mesh/session-summaries')) {
      return route.fulfill(json({ sessions: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/model/profiles') {
      return route.fulfill(json({ profiles: [], defaultAlias: '' }));
    }
    if (method === 'GET' && path === '/v1/settings/model/roles') return route.fulfill(json({ roles: {} }));
    if (method === 'GET' && path === '/v1/settings/locale') return route.fulfill(json({ locale: 'en' }));
    if (method === 'GET' && path === '/v1/settings/locales') {
      return route.fulfill(json({ locales: [{ locale: 'en', label: 'English', source: 'built-in' }] }));
    }
    if (method === 'GET' && path === '/v1/i18n/catalog') {
      return route.fulfill(json({ locale: 'en', messages: {} }));
    }
    if (method === 'GET' && path === '/v1/settings/developer') {
      developerGets += 1;
      const response = developerResponses.shift();
      if (response?.waitForRelease) {
        await new Promise<void>((resolve) => {
          releaseDeveloperGet = resolve;
        });
      }
      if (response?.status === 500) {
        return route.fulfill(json({ error: 'cannot load developer settings', code: 'INTERNAL' }, 500));
      }
      return route.fulfill(json({ developerMode, logsDir: 'logs', logs: { autoCleanup: policy } }));
    }
    if (method === 'PUT' && path === '/v1/settings/developer') {
      const body = (await request.postDataJSON()) as {
        developerMode?: boolean;
        logs?: { autoCleanup?: LogPolicy };
      };
      updates.push(body);
      const response = developerUpdateResponses.shift();
      if (response?.status === 500) {
        return route.fulfill(json({ error: 'cannot save developer settings', code: 'INTERNAL' }, 500));
      }
      if (body.developerMode !== undefined) developerMode = body.developerMode;
      if (body.logs?.autoCleanup) policy = body.logs.autoCleanup;
      return route.fulfill(json({ developerMode, logsDir: 'logs', logs: { autoCleanup: policy } }));
    }
    if (method === 'POST' && path === '/v1/settings/developer/logs/preview') {
      previews.push((await request.postDataJSON()) as LogPolicy);
      const response = previewResponses.shift() ?? { files: 4, bytes: 2048 };
      if ('networkFailure' in response) return route.abort('failed');
      if ('waitForRelease' in response) {
        await new Promise<void>((resolve) => {
          releasePreview = resolve;
        });
        return route.fulfill(json({ files: response.files, bytes: response.bytes })).catch(() => undefined);
      }
      if ('status' in response) {
        return route.fulfill(
          json({ error: 'cleanup preview is busy', code: 'RATE_LIMITED' }, 429, { 'Retry-After': '2' })
        );
      }
      return route.fulfill(json(response));
    }
    if (method === 'DELETE' && path === '/v1/settings/developer/logs') {
      clearCalls += 1;
      return route.fulfill(json(options.clearResult ?? { filesCleared: 3, filesFailed: 0, bytesFreed: 4096 }));
    }
    if (method === 'GET' && path === '/v1/settings/startup') {
      return route.fulfill(json({ enabled: false, supported: true }));
    }
    if (method === 'GET' && path === '/v1/system/upgrade') {
      return route.fulfill(
        json({
          available: false,
          currentVersion: '0.1.1',
          error: null,
          latestVersion: '0.1.1',
          progress: 0,
          stage: 'idle'
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/tool-backends') {
      return route.fulfill(
        json({
          webSearch: { provider: 'auto' },
          email: { backend: 'auto' },
          codeExec: { backend: 'follow-system', availableBackends: ['follow-system'] }
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/browser-preset') {
      return route.fulfill(json({ enabled: false, headless: true, vision: false }));
    }
    if (method === 'GET' && path === '/v1/settings/computer-preset') {
      return route.fulfill(json({ enabled: false, command: 'computer-use', args: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/obscura') {
      return route.fulfill(json({ enabled: false, stealth: false, installed: false, connected: false, tools: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/network') {
      return route.fulfill(
        json({
          port: 52749,
          transport: 'tcp',
          https: { enabled: true },
          remoteAccess: { enabled: false, token: '' },
          localHttpFallback: { enabled: false, port: 52780 }
        })
      );
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers') return route.fulfill(json({ servers: [] }));
    if (method === 'GET' && path === '/v1/settings/mcp-servers/status') {
      return route.fulfill(json({ servers: [] }));
    }
    if (method === 'GET' && path === '/v1/settings/mcp-servers/catalog') {
      return route.fulfill(json({ entries: [] }));
    }
    if (method === 'GET' && path === '/v1/atoms/mcp') return route.fulfill(json({ servers: [] }));

    return route.fulfill(json({}));
  });

  return {
    clearCalls: () => clearCalls,
    developerGets: () => developerGets,
    previews: () => previews,
    queueDeveloperResponse(response: DeveloperResponse) {
      developerResponses.push(response);
    },
    queueDeveloperUpdateResponse(response: DeveloperUpdateResponse) {
      developerUpdateResponses.push(response);
    },
    releaseDeveloperGet() {
      releaseDeveloperGet?.();
    },
    releasePreview() {
      releasePreview?.();
    },
    setDeveloperMode(value: boolean) {
      developerMode = value;
    },
    setPolicy(value: LogPolicy) {
      policy = value;
    },
    updates: () => updates
  };
}

test.describe('System log settings', () => {
  test('gates cached settings until a mount refetch accepts the fresh server policy', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      policy: { enabled: true, retentionDays: 14 }
    });
    await page.goto('/settings/system');
    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('14');

    await page.getByRole('link', { name: 'Connection' }).click();
    api.setPolicy({ enabled: true, retentionDays: 30 });
    api.queueDeveloperResponse({ waitForRelease: true });
    await page.getByRole('link', { name: 'System' }).click();

    await expect(page.getByText('Loading log settings')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Automatic log cleanup' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear all logs' })).toHaveCount(0);
    api.releaseDeveloperGet();

    const input = page.getByRole('spinbutton', { name: 'Retention period' });
    await expect(input).toHaveValue('30');
    await input.fill('21');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByRole('alertdialog')).toContainText('Keep logs for 21 days?');
    expect(api.previews()).toEqual([{ enabled: true, retentionDays: 21 }]);
    expect(api.updates()).toEqual([]);
  });

  test('gates stale controls when the post-save developer refetch fails', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      policy: { enabled: true, retentionDays: 14 }
    });
    await page.goto('/settings/system');

    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('14');
    api.queueDeveloperResponse({ status: 500, waitForRelease: true });
    await page.getByRole('spinbutton', { name: 'Retention period' }).fill('21');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByText('Loading log settings')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save cleanup policy' })).toHaveCount(0);
    await expect(page.getByText('Cleanup policy saved')).toHaveCount(0);
    api.releaseDeveloperGet();

    await expect(page.getByText('Cannot load log settings. Try again before changing cleanup.')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Automatic log cleanup' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear all logs' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('21');
  });

  test('keeps the canonical form and save failure visible when a policy update is rejected', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      policy: { enabled: true, retentionDays: 14 }
    });
    await page.goto('/settings/system');

    const input = page.getByRole('spinbutton', { name: 'Retention period' });
    await expect(input).toHaveValue('14');
    const developerGetsBeforeUpdate = api.developerGets();
    api.queueDeveloperUpdateResponse({ status: 500 });

    await input.fill('21');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByText('Cannot save the cleanup policy. Try again.')).toBeVisible();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('14');
    expect(api.developerGets()).toBe(developerGetsBeforeUpdate);
    expect(api.updates()).toEqual([{ logs: { autoCleanup: { enabled: true, retentionDays: 21 } } }]);

    await input.fill('21');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('21');
    await expect(page.getByText('Cannot save the cleanup policy. Try again.')).toHaveCount(0);
    await expect.poll(api.developerGets).toBe(developerGetsBeforeUpdate + 1);
    expect(api.updates()).toEqual([
      { logs: { autoCleanup: { enabled: true, retentionDays: 21 } } },
      { logs: { autoCleanup: { enabled: true, retentionDays: 21 } } }
    ]);
  });

  test('keeps cleanup actions unavailable until developer settings resolve', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      developerMode: true,
      developerResponses: [{ waitForRelease: true }]
    });
    await page.goto('/settings/system');

    await expect(page.getByText('Loading log settings')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Automatic log cleanup' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save cleanup policy' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear all logs' })).toHaveCount(0);
    expect(api.previews()).toEqual([]);
    expect(api.updates()).toEqual([]);
    expect(api.clearCalls()).toBe(0);

    api.releaseDeveloperGet();
    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('14');
  });

  test('failed developer settings retry uses the accepted server policy for preview decisions', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      developerMode: true,
      developerResponses: [{ status: 500 }],
      policy: { enabled: true, retentionDays: 30 }
    });
    await page.goto('/settings/system');

    await expect(page.getByText('Cannot load log settings. Try again before changing cleanup.')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Automatic log cleanup' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear all logs' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again' }).click();

    const input = page.getByRole('spinbutton', { name: 'Retention period' });
    await expect(input).toHaveValue('30');
    await input.fill('21');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByRole('alertdialog')).toContainText('Keep logs for 21 days?');
    expect(api.previews()).toEqual([{ enabled: true, retentionDays: 21 }]);
    expect(api.updates()).toEqual([]);
  });

  test('enforces whole-day bounds and saves the accepted 1 and 30 day limits', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      previewResponses: [{ files: 0, bytes: 0 }]
    });
    await page.goto('/settings/system');

    const input = page.getByRole('spinbutton', { name: 'Retention period' });
    const save = page.getByRole('button', { name: 'Save cleanup policy' });
    await expect(input).toHaveAttribute('min', '1');
    await expect(input).toHaveAttribute('max', '30');
    await expect(input).toHaveAttribute('step', '1');

    await input.fill('0');
    await expect(save).toBeDisabled();
    await input.fill('31');
    await expect(save).toBeDisabled();
    expect(api.updates()).toEqual([]);

    await input.fill('1');
    await save.click();
    await expect.poll(api.updates).toEqual([{ logs: { autoCleanup: { enabled: true, retentionDays: 1 } } }]);
    await expect.poll(api.developerGets).toBeGreaterThan(1);

    await input.fill('30');
    await save.click();
    await expect
      .poll(api.updates)
      .toEqual([
        { logs: { autoCleanup: { enabled: true, retentionDays: 1 } } },
        { logs: { autoCleanup: { enabled: true, retentionDays: 30 } } }
      ]);
    expect(api.previews()).toEqual([{ enabled: true, retentionDays: 1 }]);
  });

  test('preserves the retention value while cleanup is disabled', async ({ page }) => {
    await installSystemLogSettingsApiMock(page, {
      policy: { enabled: false, retentionDays: 12 }
    });
    await page.goto('/settings/system');

    const input = page.getByRole('spinbutton', { name: 'Retention period' });
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue('12');

    await page.getByRole('switch', { name: 'Automatic log cleanup' }).click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('12');
  });

  test('saves increased retention without preview or confirmation', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page);
    await page.goto('/settings/system');

    await page.getByRole('spinbutton', { name: 'Retention period' }).fill('21');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect.poll(api.updates).toEqual([{ logs: { autoCleanup: { enabled: true, retentionDays: 21 } } }]);
    expect(api.previews()).toEqual([]);
    // presence-ok: saving a less strict policy completes without opening a destructive confirmation
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('previews a stricter policy once and cancellation leaves settings unchanged', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page);
    await page.goto('/settings/system');

    await page.getByRole('spinbutton', { name: 'Retention period' }).fill('7');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByRole('alertdialog')).toContainText('Keep logs for 7 days?');
    await expect(page.getByRole('alertdialog')).toContainText('About 4 logs will be deleted. This cannot be undone.');
    expect(api.previews()).toEqual([{ enabled: true, retentionDays: 7 }]);
    expect(api.updates()).toEqual([]);

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('14');
    expect(api.updates()).toEqual([]);
  });

  test('uses singular day copy at the one-day confirmation boundary', async ({ page }) => {
    await installSystemLogSettingsApiMock(page);
    await page.goto('/settings/system');

    await page.getByRole('spinbutton', { name: 'Retention period' }).fill('1');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(page.getByRole('alertdialog')).toContainText('Keep logs for 1 day?');
  });

  test('previews before enabling cleanup and applies only after confirmation', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      policy: { enabled: false, retentionDays: 9 }
    });
    await page.goto('/settings/system');

    await page.getByRole('switch', { name: 'Automatic log cleanup' }).click();
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    expect(api.previews()).toEqual([{ enabled: true, retentionDays: 9 }]);
    expect(api.updates()).toEqual([]);
    await page.getByRole('button', { name: 'Apply cleanup policy' }).click();
    await expect.poll(api.updates).toEqual([{ logs: { autoCleanup: { enabled: true, retentionDays: 9 } } }]);
  });

  test('refreshing developer mode hides the clear-all action', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, { developerMode: true });
    await page.goto('/settings/system');

    await expect(page.getByRole('button', { name: 'Clear all logs' })).toBeVisible();
    api.setDeveloperMode(false);
    await page.reload();

    // presence-ok: refreshing developer settings hides clear action after developer mode is disabled
    await expect(page.getByRole('button', { name: 'Clear all logs' })).toHaveCount(0);
  });

  test('confirms clear-all and reports partial failures without claiming full success', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      developerMode: true,
      clearResult: { filesCleared: 1, filesFailed: 2, bytesFreed: 4096 }
    });
    await page.goto('/settings/system');

    await page.getByRole('button', { name: 'Clear all logs' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(
      'Daemon, session, debug, and raw fixture-capture logs will be cleared. This cannot be undone.'
    );
    expect(api.clearCalls()).toBe(0);

    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear all logs' }).click();
    await expect(page.getByText('Cleared 1 log and released 4 KB. 2 logs could not be cleared.')).toBeVisible();
    expect(api.clearCalls()).toBe(1);
  });

  test('pluralizes a single failed log independently from cleared logs', async ({ page }) => {
    await installSystemLogSettingsApiMock(page, {
      developerMode: true,
      clearResult: { filesCleared: 3, filesFailed: 1, bytesFreed: 4096 }
    });
    await page.goto('/settings/system');

    await page.getByRole('button', { name: 'Clear all logs' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear all logs' }).click();

    await expect(page.getByText('Cleared 3 logs and released 4 KB. 1 log could not be cleared.')).toBeVisible();
  });

  test('reports the exact completed clear-all result', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      developerMode: true,
      clearResult: { filesCleared: 3, filesFailed: 0, bytesFreed: 4096 }
    });
    await page.goto('/settings/system');

    await page.getByRole('button', { name: 'Clear all logs' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear all logs' }).click();

    await expect(page.getByText('Cleared 3 logs and released 4 KB.', { exact: true })).toBeVisible();
    expect(api.clearCalls()).toBe(1);
  });

  test('a rate-limited preview keeps the stricter policy unsaved and retries safely', async ({ page }) => {
    const api = await installSystemLogSettingsApiMock(page, {
      previewResponses: [{ status: 429 }, { files: 2, bytes: 1024 }]
    });
    await page.goto('/settings/system');

    await page.getByRole('spinbutton', { name: 'Retention period' }).fill('5');
    await page.getByRole('button', { name: 'Save cleanup policy' }).click();

    await expect(
      page.getByText('Cannot check which logs would be deleted. Try again before saving this stricter policy.')
    ).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'Retention period' })).toHaveValue('14');
    expect(api.previews()).toEqual([{ enabled: true, retentionDays: 5 }]);
    expect(api.updates()).toEqual([]);
    // presence-ok: a failed preview prevents destructive confirmation from opening
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Keep logs for 5 days?');
    expect(api.previews()).toEqual([
      { enabled: true, retentionDays: 5 },
      { enabled: true, retentionDays: 5 }
    ]);
    expect(api.updates()).toEqual([]);
  });

  for (const failure of [
    { label: 'network failure', response: { networkFailure: true } as PreviewResponse },
    { label: 'timeout', response: { waitForRelease: true, files: 2, bytes: 1024 } as PreviewResponse }
  ]) {
    test(`a preview ${failure.label} leaves the policy unsaved with a retry path`, async ({ page }) => {
      const api = await installSystemLogSettingsApiMock(page, {
        previewResponses: [failure.response, { files: 2, bytes: 1024 }]
      });
      await page.goto('/settings/system');
      if (failure.label === 'timeout') await page.clock.install();

      await page.getByRole('spinbutton', { name: 'Retention period' }).fill('5');
      await page.getByRole('button', { name: 'Save cleanup policy' }).click();
      if (failure.label === 'timeout') {
        await expect.poll(api.previews).toHaveLength(1);
        await page.clock.fastForward(5_000);
      }

      await expect(
        page.getByText('Cannot check which logs would be deleted. Try again before saving this stricter policy.')
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(api.updates()).toEqual([]);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);

      api.releasePreview();
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('alertdialog')).toContainText('Keep logs for 5 days?');
      expect(api.updates()).toEqual([]);
    });
  }
});
