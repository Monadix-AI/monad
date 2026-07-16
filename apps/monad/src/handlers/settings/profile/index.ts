import type { SetUserProfileSettingsRequest, UserProfileSettings } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

export function createUserProfileModule(config: ConfigAccess) {
  async function getProfileSettings(): Promise<UserProfileSettings> {
    const cfg = config.get().cfg;
    return {
      displayName: cfg.user.displayName,
      avatarDataUrl: cfg.user.avatarDataUrl
    };
  }

  async function setProfileSettings(req: SetUserProfileSettingsRequest): Promise<UserProfileSettings> {
    await config.updateConfig((cfg) => {
      cfg.user.displayName = req.displayName.trim();
      cfg.user.avatarDataUrl = req.avatarDataUrl;
    });
    return getProfileSettings();
  }

  return { getProfileSettings, setProfileSettings };
}
