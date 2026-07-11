import type { MonadPaths } from '@monad/home';
import type { AppearanceSettings, SetAppearanceSettingsRequest } from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createAppearanceModule(paths: MonadPaths, configReloader?: ConfigReloader) {
  async function getAppearanceSettings(): Promise<AppearanceSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('appearance settings: config.json missing');
    return cfg.appearance;
  }

  async function setAppearanceSettings(req: SetAppearanceSettingsRequest): Promise<AppearanceSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('appearance settings: config.json missing');
    cfg.appearance = req;
    await saveProfile(paths.profile, cfg);
    if (configReloader) await configReloader.publish({ cfg, auth: await loadAuth(paths.auth) });
    return getAppearanceSettings();
  }

  return { getAppearanceSettings, setAppearanceSettings };
}
