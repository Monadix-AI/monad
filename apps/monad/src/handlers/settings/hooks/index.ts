import type { HooksConfig, MonadPaths } from '@monad/home';
import type { HooksSettingsResponse, SetHooksSettingsRequest } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createHooksModule(paths: MonadPaths, configBus?: ConfigBus) {
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
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }

    return getHooks();
  }

  return { getHooks, setHooks };
}
