import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultConfig, loadConfig, saveSystemConfig } from '../../src/config/index.ts';
import {
  disableRemoteAccess,
  enableRemoteAccess,
  generateRemoteToken,
  getLanIp,
  getTailscaleIp
} from '../../src/remote-access.ts';

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `remote-access-test-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  configPath = join(tmpDir, 'config.json');
  const cfg = createDefaultConfig('prn_test', 'Test User');
  await saveSystemConfig(configPath, cfg);
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
    const { token, changed } = await enableRemoteAccess(configPath);
    expect(changed).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cfg = await loadConfig(configPath);
    expect(cfg?.network.remoteAccess.enabled).toBe(true);
    expect(cfg?.network.remoteAccess.token).toBe(token);
  });

  test('is idempotent: second call returns changed=false and same token', async () => {
    const { token: t1 } = await enableRemoteAccess(configPath);
    const { token: t2, changed } = await enableRemoteAccess(configPath);
    expect(changed).toBe(false);
    expect(t1).toBe(t2);
  });

  test('rotate=true replaces the existing token', async () => {
    const { token: t1 } = await enableRemoteAccess(configPath);
    const { token: t2, changed } = await enableRemoteAccess(configPath, { rotate: true });
    expect(changed).toBe(true);
    expect(t2).not.toBe(t1);
    expect(t2).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cfg = await loadConfig(configPath);
    expect(cfg?.network.remoteAccess.token).toBe(t2);
  });

  test('throws if config is missing', async () => {
    await expect(enableRemoteAccess(join(tmpDir, 'nonexistent.json'))).rejects.toThrow('monad: config not found');
  });
});

describe('disableRemoteAccess', () => {
  test('sets enabled=false and clears the token', async () => {
    await enableRemoteAccess(configPath);
    await disableRemoteAccess(configPath);

    const cfg = await loadConfig(configPath);
    expect(cfg?.network.remoteAccess.enabled).toBe(false);
    expect(cfg?.network.remoteAccess.token).toBeNull();
  });

  test('is a no-op when config is missing', async () => {
    await expect(disableRemoteAccess(join(tmpDir, 'nonexistent.json'))).resolves.toBeUndefined();
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
