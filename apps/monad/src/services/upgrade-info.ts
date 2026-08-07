import type { MonadPaths } from '@monad/environment';

import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';
import { z } from 'zod';

import { sendSystemNotification } from '#/services/system-notification.ts';

const RELEASE_REPOSITORY = 'Monadix-AI/monad';
const latestReleaseSchema = z.object({ tag_name: z.string().optional() });
const upgradeInfoCacheSchema = z.object({
  latestVersion: z.string(),
  latestVersionCheckedAt: z.string(),
  lastNotifiedVersion: z.string().optional()
});

export interface UpgradeInfo {
  latestVersion: string;
  latestVersionCheckedAt: string;
}

interface UpgradeInfoMonitorDeps {
  notifyUpdateAvailable?: (latestVersion: string, currentVersion: string) => Promise<boolean>;
  settingsUrl?: string;
}

export async function createUpgradeInfoMonitor(
  paths: MonadPaths,
  deps: UpgradeInfoMonitorDeps = {}
): Promise<{
  getUpgradeInfo: () => UpgradeInfo | null;
}> {
  let upgradeInfo: UpgradeInfo | null = null;
  let lastNotifiedVersion: string | undefined;
  const upgradeInfoCachePath = join(paths.cache, 'upgrade-info.json');
  const notifyUpdateAvailable =
    deps.notifyUpdateAvailable ??
    ((latestVersion: string, _currentVersion: string) =>
      sendSystemNotification({
        title: 'Monad Update Available',
        subtitle: `Version ${latestVersion}`,
        body: 'A new version of Monad is ready. Run monad upgrade to install it.',
        actionUrl: deps.settingsUrl
      }));

  async function persist(): Promise<void> {
    if (!upgradeInfo) return;
    try {
      await Bun.write(upgradeInfoCachePath, JSON.stringify({ ...upgradeInfo, lastNotifiedVersion }));
    } catch {
      /* non-fatal */
    }
  }

  async function checkLatestVersion(): Promise<void> {
    try {
      const res = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
        headers: { 'User-Agent': `monad-daemon/${MONAD_VERSION}` }
      });
      if (res.ok) {
        const data = latestReleaseSchema.parse(await res.json());
        if (data.tag_name) {
          upgradeInfo = {
            latestVersion: data.tag_name.replace(/^v/, ''),
            latestVersionCheckedAt: new Date().toISOString()
          };
          await persist();
          if (
            isNewerVersion(upgradeInfo.latestVersion, MONAD_VERSION) &&
            lastNotifiedVersion !== upgradeInfo.latestVersion
          ) {
            const notified = await notifyUpdateAvailable(upgradeInfo.latestVersion, MONAD_VERSION);
            if (notified) {
              lastNotifiedVersion = upgradeInfo.latestVersion;
              await persist();
            }
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }

  try {
    const cached = await Bun.file(upgradeInfoCachePath).text();
    const parsed = upgradeInfoCacheSchema.parse(JSON.parse(cached));
    upgradeInfo = {
      latestVersion: parsed.latestVersion,
      latestVersionCheckedAt: parsed.latestVersionCheckedAt
    };
    lastNotifiedVersion = parsed.lastNotifiedVersion;
  } catch {
    /* no prior cache or malformed */
  }

  void checkLatestVersion();
  setInterval(() => void checkLatestVersion(), 6 * 60 * 60 * 1000);

  return { getUpgradeInfo: () => upgradeInfo };
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = numericVersion(candidate);
  const currentParts = numericVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }
  return false;
}

function numericVersion(version: string): [number, number, number] | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
