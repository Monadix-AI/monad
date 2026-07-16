import type { HooksConfig } from '@monad/environment';
import type { HooksSettingsResponse, SetHooksSettingsRequest } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

export function createHooksModule(config: ConfigAccess) {
  async function getHooks(): Promise<HooksSettingsResponse> {
    const cfg = config.get().cfg;
    return { hooks: cfg.hooks ?? {} };
  }

  async function setHooks(req: SetHooksSettingsRequest): Promise<HooksSettingsResponse> {
    await config.updateConfig((cfg) => {
      cfg.hooks = req.hooks as HooksConfig;
    });

    return getHooks();
  }

  return { getHooks, setHooks };
}
