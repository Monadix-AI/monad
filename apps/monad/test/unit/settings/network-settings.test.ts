import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome } from '@monad/environment';

import { ConfigManager } from '#/config/manager.ts';
import { createHomeConfigSource } from '#/config/source.ts';
import { createNetworkModule } from '#/handlers/settings/network/index.ts';
import { createTestConfigManager, makeTestPaths } from '../../helpers.ts';

test('network settings apply through config bus without requiring a daemon restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-network-settings-'));
  try {
    const paths = makeTestPaths(dir);
    await initMonadHome(paths);
    const published: boolean[] = [];
    const source = createHomeConfigSource(paths);
    const config = new ConfigManager({
      initial: await ConfigManager.load(source),
      source,
      apply: async ({ cfg }) => {
        published.push(cfg.network.remoteAccess.enabled);
      }
    });

    const mod = createNetworkModule(paths, config);
    const result = await mod.setNetworkSettings({ remoteAccess: { enabled: true } });

    expect(result).toMatchObject({
      https: { enabled: true },
      remoteAccess: { enabled: true, token: expect.any(String) },
      restartRequired: false
    });
    expect(published).toEqual([true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('network settings require an explicit acknowledgment before exposing remote HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-network-settings-'));
  try {
    const paths = makeTestPaths(dir);
    await initMonadHome(paths);
    const config = await createTestConfigManager(paths);
    const mod = createNetworkModule(paths, config);

    await expect(
      mod.setNetworkSettings({
        https: { enabled: false },
        remoteAccess: { enabled: true }
      })
    ).rejects.toThrow('Plain HTTP remote access requires explicit confirmation');

    const result = await mod.setNetworkSettings({
      confirmInsecureRemoteAccess: true,
      https: { enabled: false },
      remoteAccess: { enabled: true }
    });

    expect(result).toMatchObject({
      https: { enabled: false },
      remoteAccess: { enabled: true, token: expect.any(String) },
      remoteUrls: expect.arrayContaining([expect.objectContaining({ url: expect.stringMatching(/^http:\/\//) })])
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('network HTTPS scheme changes publish after the settings response returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-network-settings-'));
  try {
    const paths = makeTestPaths(dir);
    await initMonadHome(paths);
    const published: boolean[] = [];
    const source = createHomeConfigSource(paths);
    const config = new ConfigManager({
      initial: await ConfigManager.load(source),
      source,
      apply: async ({ cfg }) => {
        published.push(cfg.network.https.enabled);
      }
    });

    const mod = createNetworkModule(paths, config);
    const result = await mod.setNetworkSettings({ https: { enabled: true } });

    expect(result.https.enabled).toBe(true);
    expect(result.restartRequired).toBe(false);
    expect(published).toEqual([true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('network settings expose remote URLs and token revision for the current daemon', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-network-settings-'));
  try {
    const paths = makeTestPaths(dir);
    await initMonadHome(paths);
    const config = await createTestConfigManager(paths);
    const mod = createNetworkModule(paths, config, {
      currentRuntimeStatus: () => ({
        listeners: [{ scheme: 'https', host: '0.0.0.0', port: 52749 }],
        remoteAccess: { enabled: true, tokenRevision: 2 },
        lastAppliedAt: '2026-07-07T00:00:00.000Z'
      }),
      networkAddresses: () => ({ lan: '172.16.112.210', overlay: '100.64.1.2' })
    });

    await mod.setNetworkSettings({ remoteAccess: { enabled: true } });
    const result = await mod.getNetworkSettings();
    const runtime = result.runtime;

    if (!runtime) throw new Error('expected runtime status');
    expect(runtime.remoteAccess.tokenRevision).toBe(2);
    expect(result.remoteUrls).toEqual([
      { kind: 'lan', label: 'LAN', url: 'https://172.16.112.210:52749' },
      { kind: 'overlay', label: 'Tailscale', url: 'https://100.64.1.2:52749' }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('network probe reports ok responses and failed checks without throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-network-settings-'));
  try {
    const paths = makeTestPaths(dir);
    await initMonadHome(paths);
    const config = await createTestConfigManager(paths);
    const mod = createNetworkModule(paths, config, {
      probeFetch: async (input, init) => {
        expect(String(input)).toBe('https://172.16.112.210:52749/health');
        expect(init?.headers).toEqual({ authorization: 'Bearer secret' });
        return Response.json({ status: 'ok', version: 'test' });
      }
    });

    await expect(mod.probeNetwork({ url: 'https://172.16.112.210:52749', token: 'secret' })).resolves.toMatchObject({
      ok: true,
      status: 200
    });

    const failed = createNetworkModule(paths, config, {
      probeFetch: async () => {
        throw new Error('connection refused');
      }
    });
    await expect(failed.probeNetwork({ url: 'https://172.16.112.210:52749' })).resolves.toMatchObject({
      error: 'connection refused',
      ok: false
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
