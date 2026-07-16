import type { MonadPaths } from '@monad/environment';
import type { DeveloperSettings, SetDeveloperSettingsRequest } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import { configureDeveloperLogTransport, developerLogsDir } from '#/services/developer-log.ts';

export function createDeveloperModule(paths: MonadPaths, config: ConfigAccess) {
  async function getDeveloperSettings(): Promise<DeveloperSettings> {
    const cfg = config.get().cfg;
    return { developerMode: cfg.developerMode === true, logsDir: developerLogsDir(paths) };
  }

  async function setDeveloperSettings(req: SetDeveloperSettingsRequest): Promise<DeveloperSettings> {
    await config.updateConfig((cfg) => {
      cfg.developerMode = req.developerMode;
    });
    configureDeveloperLogTransport(paths, req.developerMode);
    return getDeveloperSettings();
  }

  return { getDeveloperSettings, setDeveloperSettings };
}
