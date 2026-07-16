import type { MonadPaths } from '@monad/environment';

import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

const RELEASE_REPOSITORY = 'Monadix-AI/monad';

export interface UpgradeInfo {
  latestVersion: string;
  latestVersionCheckedAt: string;
}

export async function createUpgradeInfoMonitor(paths: MonadPaths): Promise<{
  getUpgradeInfo: () => UpgradeInfo | null;
}> {
  let upgradeInfo: UpgradeInfo | null = null;
  const upgradeInfoCachePath = join(paths.cache, 'upgrade-info.json');

  async function checkLatestVersion(): Promise<void> {
    try {
      const res = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
        headers: { 'User-Agent': `monad-daemon/${MONAD_VERSION}` }
      });
      if (res.ok) {
        const data = (await res.json()) as { tag_name?: string };
        if (data.tag_name) {
          upgradeInfo = {
            latestVersion: data.tag_name.replace(/^v/, ''),
            latestVersionCheckedAt: new Date().toISOString()
          };
          try {
            await Bun.write(upgradeInfoCachePath, JSON.stringify(upgradeInfo));
          } catch {
            /* non-fatal */
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }

  try {
    const cached = await Bun.file(upgradeInfoCachePath).text();
    upgradeInfo = JSON.parse(cached) as UpgradeInfo;
  } catch {
    /* no prior cache or malformed */
  }

  void checkLatestVersion();
  setInterval(() => void checkLatestVersion(), 6 * 60 * 60 * 1000);

  return { getUpgradeInfo: () => upgradeInfo };
}
