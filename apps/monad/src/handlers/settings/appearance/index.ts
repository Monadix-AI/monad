import type { MonadPaths } from '@monad/home';
import type { AppearanceSettings, SetAppearanceSettingsRequest } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createAppearanceModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getAppearanceSettings(): Promise<AppearanceSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('appearance settings: config.json missing');
    return { avatarStyle: cfg.appearance.avatarStyle };
  }

  async function setAppearanceSettings(req: SetAppearanceSettingsRequest): Promise<AppearanceSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('appearance settings: config.json missing');
    cfg.appearance.avatarStyle = req.avatarStyle;
    await saveProfile(paths.profile, cfg);
    if (configBus) await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    return getAppearanceSettings();
  }

  return { getAppearanceSettings, setAppearanceSettings };
}
