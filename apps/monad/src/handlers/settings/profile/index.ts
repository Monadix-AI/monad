import type { MonadPaths } from '@monad/home';
import type { SetUserProfileSettingsRequest, UserProfileSettings } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { loadAll, loadAuth, saveAll } from '@monad/home';

export function createUserProfileModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getProfileSettings(): Promise<UserProfileSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('profile settings: config.json missing');
    return {
      displayName: cfg.principal.displayName,
      avatarDataUrl: cfg.user.avatarDataUrl
    };
  }

  async function setProfileSettings(req: SetUserProfileSettingsRequest): Promise<UserProfileSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('profile settings: config.json missing');
    cfg.principal.displayName = req.displayName.trim();
    cfg.user.avatarDataUrl = req.avatarDataUrl;
    await saveAll(paths.config, paths.profile, cfg);
    if (configBus) await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    return getProfileSettings();
  }

  return { getProfileSettings, setProfileSettings };
}
