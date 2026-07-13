import type { SandboxBackendRef, SandboxLauncher } from '@monad/sdk-atom';

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth } from '@monad/home';
import { clearSandboxLaunchers, registerSandboxLauncher } from '@monad/sandbox';

import { createSandboxModule } from '#/handlers/settings/sandbox/index.ts';
import { makeTestPaths } from '../../helpers.ts';

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
  return { dir, paths, mod: createSandboxModule(paths) };
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

    const cfg = await loadAll(paths.config, paths.profile);
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

    let auth = await loadAuth(paths.auth);
    expect(auth?.namedSecrets?.['sandbox/atom-pack/vendor/cloud/apiKey']).toBe('first-secret');
    let cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.sandbox.backendSettings['atom-pack/vendor/cloud']?.apiKey).toBe(
      '$' + '{secret:sandbox/atom-pack/vendor/cloud/apiKey}'
    );

    await mod.setSandboxSettings({
      backendSettings: { ref, secrets: { apiKey: { action: 'replace', value: 'second-secret' } } }
    });
    auth = await loadAuth(paths.auth);
    expect(auth?.namedSecrets?.['sandbox/atom-pack/vendor/cloud/apiKey']).toBe('second-secret');

    view = await mod.setSandboxSettings({ backendSettings: { ref, secrets: { apiKey: { action: 'remove' } } } });
    expect(view.backendSettings['atom-pack/vendor/cloud']?.apiKey).toEqual({ configured: false });
    auth = await loadAuth(paths.auth);
    expect(auth?.namedSecrets?.['sandbox/atom-pack/vendor/cloud/apiKey']).toBeUndefined();
    cfg = await loadAll(paths.config, paths.profile);
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
    expect(JSON.stringify(view)).not.toContain('${secret:');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('migrates legacy backend selectors to source-qualified references', async () => {
  const { dir, paths } = await fixture();
  try {
    await Bun.write(paths.sandbox, `${JSON.stringify({ backend: 'vm', vm: { cpus: 4, memory: 4096 } })}\n`);
    let cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.sandbox.activeBackend).toEqual({ source: 'builtin', kind: 'vm' });
    expect(cfg?.sandbox.backendSettings['builtin/vm']).toEqual({ cpus: 4, memoryMiB: 4096 });

    await Bun.write(paths.sandbox, `${JSON.stringify({ backend: 'e2b' })}\n`);
    cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.sandbox.activeBackend).toEqual({ source: 'atom-pack', packId: 'monad-power-pack', kind: 'e2b' });

    await Bun.write(paths.sandbox, `${JSON.stringify({ backend: 'docker', dockerImage: 'debian:stable' })}\n`);
    cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.sandbox.backendSettings['atom-pack/monad-power-pack/docker']).toEqual({ image: 'debian:stable' });

    await Bun.write(paths.sandbox, `${JSON.stringify({ backend: 'e2b', credential: '$' + '{env:E2B_API_KEY}' })}\n`);
    cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.sandbox.backendSettings['atom-pack/monad-power-pack/e2b']).toEqual({
      apiKey: '$' + '{env:E2B_API_KEY}'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
