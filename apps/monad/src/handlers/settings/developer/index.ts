import type { MonadPaths } from '@monad/home';
import type { DeveloperSettings, SetDeveloperSettingsRequest } from '@monad/protocol';
import type { ConfigBus } from '#/services/config-bus.ts';

import { loadAll, loadAuth, saveSystemConfig } from '@monad/home';

import { configureDeveloperLogTransport, developerLogsDir } from '#/services/developer-log.ts';

export function createDeveloperModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getDeveloperSettings(): Promise<DeveloperSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('developer settings: config.json missing');
    return { developerMode: cfg.developerMode === true, logsDir: developerLogsDir(paths) };
  }

  async function setDeveloperSettings(req: SetDeveloperSettingsRequest): Promise<DeveloperSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('developer settings: config.json missing');
    cfg.developerMode = req.developerMode;
    await saveSystemConfig(paths.config, cfg);
    configureDeveloperLogTransport(paths, req.developerMode);
    if (configBus) await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    return getDeveloperSettings();
  }

  return { getDeveloperSettings, setDeveloperSettings };
}
