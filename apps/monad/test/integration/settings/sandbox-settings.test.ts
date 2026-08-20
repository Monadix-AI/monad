import type { SandboxBackendRef, SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth } from '@monad/environment';
import { clearSandboxLaunchers, registerSandboxLauncher } from '@monad/sandbox';

import { createSandboxModule } from '#/handlers/settings/sandbox/index.ts';
import { createConfigSandboxActivationService } from '#/platform/sandbox/activation.ts';
import { redactBackendSettings } from '#/platform/sandbox/backend-settings.ts';
import { createTestConfigManager, makeTestPaths } from '../../helpers.ts';

afterEach(() => clearSandboxLaunchers());

function launcher(kind: string): SandboxLauncher {
  return {
    kind,
    descriptor: {
      name: `Test ${kind}`,
      settings: {
        fields: [
          { id: 'region', type: 'select', label: 'Region', options: [{ value: 'us-east', label: 'US East' }] },
          { id: 'workers', type: 'number', label: 'Workers', min: 1, max: 8 },
          { id: 'apiKey', type: 'secret', label: 'API key', required: true }
        ]
      }
    },
    isAvailable: () => true,
    wrap: (argv) => argv
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'monad-sandbox-settings-'));
  const paths = makeTestPaths(dir);
  await initMonadHome(paths);
  const config = await createTestConfigManager(paths);
  return { dir, paths, mod: createSandboxModule(config, createConfigSandboxActivationService(config)) };
}

test('persists normal settings by source-qualified backend identity', async () => {
  const { dir, paths, mod } = await fixture();
  const first = { source: 'atom-pack', packId: 'vendor-a', kind: 'cloud' } as const;
  const second = { source: 'atom-pack', packId: 'vendor-b', kind: 'cloud' } as const;
  registerSandboxLauncher(launcher('cloud'), first);
  registerSandboxLauncher(launcher('cloud'), second);

  try {
    await mod.setSandboxSettings({ backendSettings: { ref: first, values: { region: 'us-east', workers: 2 } } });
    await mod.setSandboxSettings({ backendSettings: { ref: second, values: { region: 'us-east', workers: 4 } } });

    const view = await mod.getSandboxSettings();
    expect(view.backendSettings['atom-pack/vendor-a/cloud']).toEqual({
      region: 'us-east',
      workers: 2,
      apiKey: { configured: false }
    });
    expect(view.backendSettings['atom-pack/vendor-b/cloud']).toEqual({
      region: 'us-east',
      workers: 4,
      apiKey: { configured: false }
    });

    const cfg = await loadAll(paths);
    expect(cfg?.sandbox.backendSettings['atom-pack/vendor-a/cloud']).toEqual({ region: 'us-east', workers: 2 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes, redacts, replaces, and explicitly removes backend secrets', async () => {
  const { dir, paths, mod } = await fixture();
  const ref = { source: 'atom-pack', packId: 'vendor', kind: 'cloud' } as const;
  registerSandboxLauncher(launcher('cloud'), ref);

  try {
    let view = await mod.setSandboxSettings({
      backendSettings: { ref, secrets: { apiKey: { action: 'replace', value: 'first-secret' } } }
    });
    expect(view.backendSettings['atom-pack/vendor/cloud']?.apiKey).toEqual({ configured: true });
    expect(JSON.stringify(view)).not.toContain('first-secret');

    let cfg = await loadAll(paths);
    expect(cfg?.sandbox.backendSettings['atom-pack/vendor/cloud']?.apiKey).toBe('first-secret');
    expect((await loadAuth(paths.auth))?.credentials).toEqual({});

    await mod.setSandboxSettings({
      backendSettings: { ref, secrets: { apiKey: { action: 'replace', value: 'second-secret' } } }
    });
    cfg = await loadAll(paths);
    expect(cfg?.sandbox.backendSettings['atom-pack/vendor/cloud']?.apiKey).toBe('second-secret');

    view = await mod.setSandboxSettings({ backendSettings: { ref, secrets: { apiKey: { action: 'remove' } } } });
    expect(view.backendSettings['atom-pack/vendor/cloud']?.apiKey).toEqual({ configured: false });
    cfg = await loadAll(paths);
    expect(cfg?.sandbox.backendSettings['atom-pack/vendor/cloud']?.apiKey).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retains and redacts settings after a contributed backend is disabled', async () => {
  const { dir, mod } = await fixture();
  const ref: SandboxBackendRef = { source: 'atom-pack', packId: 'vendor', kind: 'cloud' };
  registerSandboxLauncher(launcher('cloud'), ref);

  try {
    await mod.setSandboxSettings({
      backendSettings: {
        ref,
        values: { region: 'us-east' },
        secrets: { apiKey: { action: 'replace', value: 'retained-secret' } }
      }
    });
    clearSandboxLaunchers();

    const view = await mod.getSandboxSettings();
    expect(view.backendSettings['atom-pack/vendor/cloud']).toEqual({
      region: 'us-east',
      apiKey: { configured: true }
    });
    expect(JSON.stringify(view)).not.toContain('retained-secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('omits opaque stored fields when the backend descriptor is unavailable or changed', () => {
  const key = 'atom-pack/vendor/cloud';
  const stored = {
    [key]: {
      region: 'us-east',
      retiredSecret: 'sandbox-canary-secret'
    }
  };

  expect(
    redactBackendSettings(stored, { version: 1, updatedAt: new Date().toISOString(), credentials: {} }, new Map())
  ).toEqual({
    [key]: {}
  });
  const changed = redactBackendSettings(
    stored,
    { version: 1, updatedAt: new Date().toISOString(), credentials: {} },
    new Map([
      [
        key,
        {
          name: 'Changed backend',
          settings: { fields: [{ id: 'region', type: 'string', label: 'Region' }] }
        }
      ]
    ])
  );
  expect(changed).toEqual({ [key]: { region: 'us-east' } });
  expect(JSON.stringify(changed)).not.toContain('sandbox-canary-secret');
});

test('rejects unknown fields and values that violate the contributed schema', async () => {
  const { dir, mod } = await fixture();
  const ref = { source: 'atom-pack', packId: 'vendor', kind: 'cloud' } as const;
  registerSandboxLauncher(launcher('cloud'), ref);

  try {
    await expect(mod.setSandboxSettings({ backendSettings: { ref, values: { region: 'unknown' } } })).rejects.toThrow(
      'region'
    );
    await expect(mod.setSandboxSettings({ backendSettings: { ref, values: { workers: 0 } } })).rejects.toThrow(
      'workers'
    );
    await expect(mod.setSandboxSettings({ backendSettings: { ref, values: { apiKey: 'plaintext' } } })).rejects.toThrow(
      'apiKey'
    );
    await expect(mod.setSandboxSettings({ backendSettings: { ref, values: { extra: true } } })).rejects.toThrow(
      'extra'
    );
    await expect(
      mod.setSandboxSettings({
        backendSettings: { ref, secrets: { apiKey: { action: 'replace', value: '' } } }
      })
    ).rejects.toThrow('apiKey');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
