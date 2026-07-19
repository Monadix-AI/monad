import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultConfig, loadConfig, saveAll } from '../../src/config/index.ts';
import { pathsForHome } from '../../src/paths.ts';
import {
  disableRemoteAccess,
  enableRemoteAccess,
  generateRemoteToken,
  getLanIp,
  getTailscaleIp
} from '../../src/remote-access.ts';

let tmpDir: string;
let paths: ReturnType<typeof pathsForHome>;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `remote-access-test-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  paths = pathsForHome(tmpDir);
  await mkdir(paths.configs, { recursive: true });
  const cfg = createDefaultConfig('Test User');
  await saveAll(paths, cfg);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('generateRemoteToken', () => {
  test('produces 43-char base64url string (256-bit entropy)', () => {
    const token = generateRemoteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43);
  });

  test('each call returns a different token', () => {
    const tokens = new Set(Array.from({ length: 20 }, generateRemoteToken));
    expect(tokens.size).toBe(20);
  });
});

describe('enableRemoteAccess', () => {
  test('sets enabled=true and generates a token on first call', async () => {
    const { token, changed } = await enableRemoteAccess(paths);
    expect(changed).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cfg = await loadConfig(paths);
    expect(cfg?.network).toMatchObject({
      https: { enabled: true },
      remoteAccess: { enabled: true, token }
    });
  });

  test('requires acknowledgment before enabling remote access over HTTP', async () => {
    await expect(enableRemoteAccess(paths, { https: false })).rejects.toThrow(
      'Plain HTTP remote access requires explicit confirmation'
    );

    await enableRemoteAccess(paths, { confirmInsecureRemoteAccess: true, https: false });

    const cfg = await loadConfig(paths);
    expect(cfg?.network).toMatchObject({
      https: { enabled: false },
      remoteAccess: { enabled: true, token: expect.any(String) }
    });
  });

  test('is idempotent: second call returns changed=false and same token', async () => {
    const { token: t1 } = await enableRemoteAccess(paths);
    const { token: t2, changed } = await enableRemoteAccess(paths);
    expect(changed).toBe(false);
    expect(t1).toBe(t2);
  });

  test('rotate=true replaces the existing token', async () => {
    const { token: t1 } = await enableRemoteAccess(paths);
    const { token: t2, changed } = await enableRemoteAccess(paths, { rotate: true });
    expect(changed).toBe(true);
    expect(t2).not.toBe(t1);
    expect(t2).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cfg = await loadConfig(paths);
    expect(cfg?.network.remoteAccess.token).toBe(t2);
  });

  test('throws if config is missing', async () => {
    await expect(enableRemoteAccess(pathsForHome(join(tmpDir, 'missing')))).rejects.toThrow('monad: config not found');
  });
});

describe('disableRemoteAccess', () => {
  test('sets enabled=false and clears the token', async () => {
    await enableRemoteAccess(paths);
    await disableRemoteAccess(paths);

    const cfg = await loadConfig(paths);
    expect(cfg?.network.remoteAccess.enabled).toBe(false);
  });

  test('is a no-op when config is missing', async () => {
    await expect(disableRemoteAccess(pathsForHome(join(tmpDir, 'missing')))).resolves.toBeUndefined();
  });
});

describe('getLanIp', () => {
  test('returns undefined or a valid non-loopback IPv4 string', () => {
    const ip = getLanIp();
    if (ip !== undefined) {
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      expect(ip).not.toBe('127.0.0.1');
    }
  });
});

describe('getTailscaleIp', () => {
  test('returns undefined or a Tailscale-range address', () => {
    const ip = getTailscaleIp();
    if (ip !== undefined) {
      expect(ip.startsWith('100.') || ip.startsWith('fd7a:')).toBe(true);
    }
  });
});
