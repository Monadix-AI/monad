import type { ConfigFilePaths } from './config/index.ts';

import { randomBytes } from 'node:crypto';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

import { loadConfig, saveConfig } from './config/index.ts';

export function generateRemoteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Enable remote access. Generates a new token when none exists or when `rotate` is true.
 * Returns the active token and whether the config was modified.
 */
export async function enableRemoteAccess(
  paths: ConfigFilePaths,
  opts?: { rotate?: boolean }
): Promise<{ token: string; changed: boolean }> {
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('monad: config not found — run `monad init` first');

  const existing = cfg.network.remoteAccess;
  const needToken = !existing.token || opts?.rotate === true;
  const token = needToken ? generateRemoteToken() : (existing.token ?? generateRemoteToken());
  const changed = !existing.enabled || needToken;

  if (changed) {
    await saveConfig(paths.config, {
      ...cfg,
      network: {
        ...cfg.network,
        remoteAccess: { ...existing, enabled: true, token }
      }
    });
  }

  return { token, changed };
}

/** Disable remote access and clear the token. */
export async function disableRemoteAccess(paths: ConfigFilePaths): Promise<void> {
  const cfg = await loadConfig(paths);
  if (!cfg) return;
  await saveConfig(paths.config, {
    ...cfg,
    network: {
      ...cfg.network,
      remoteAccess: { ...cfg.network.remoteAccess, enabled: false, token: null }
    }
  });
}

/** Return the first non-loopback IPv4 address (used to build the LAN pairing URL). */
export function getLanIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const info of iface as NetworkInterfaceInfo[]) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return undefined;
}

/** Return the first Tailscale overlay address (100.x.x.x or fd7a:… range). */
export function getTailscaleIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const info of iface as NetworkInterfaceInfo[]) {
      if (info.family === 'IPv4' && info.address.startsWith('100.')) return info.address;
      if (info.family === 'IPv6' && info.address.startsWith('fd7a:')) return info.address;
    }
  }
  return undefined;
}
