import type { AppearanceSettings, SetAppearanceSettingsRequest } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

export function createAppearanceModule(config: ConfigAccess) {
  async function getAppearanceSettings(): Promise<AppearanceSettings> {
    return config.get().cfg.appearance;
  }

  async function setAppearanceSettings(req: SetAppearanceSettingsRequest): Promise<AppearanceSettings> {
    await config.updateConfig((cfg) => {
      cfg.appearance = req;
    });
    return getAppearanceSettings();
  }

  return { getAppearanceSettings, setAppearanceSettings };
}
