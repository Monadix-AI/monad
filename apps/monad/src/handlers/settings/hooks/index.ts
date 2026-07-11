import type { HooksConfig, MonadPaths } from '@monad/home';
import type { HooksSettingsResponse, SetHooksSettingsRequest } from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createHooksModule(paths: MonadPaths, configReloader?: ConfigReloader) {
  async function getHooks(): Promise<HooksSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('hooks: config.json missing');
    return { hooks: cfg.hooks ?? {} };
  }

  async function setHooks(req: SetHooksSettingsRequest): Promise<HooksSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('hooks: config.json missing');

    cfg.hooks = req.hooks as HooksConfig;

    await saveProfile(paths.profile, cfg);
    if (configReloader) {
      await configReloader.publish({ cfg, auth: await loadAuth(paths.auth) });
    }

    return getHooks();
  }

  return { getHooks, setHooks };
}
