import type { OpenaiCompatSettings, SetOpenaiCompatRequest } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

export function createOpenaiCompatModule(config: ConfigAccess) {
  async function getOpenaiCompat(): Promise<OpenaiCompatSettings> {
    const cfg = config.get().cfg;
    return {
      enabled: cfg?.openaiCompat?.enabled ?? false,
      token: cfg?.openaiCompat?.token
    };
  }

  async function setOpenaiCompat(req: SetOpenaiCompatRequest): Promise<OpenaiCompatSettings> {
    await config.updateConfig((cfg) => {
      cfg.openaiCompat = {
        enabled: req.enabled,
        token: req.token ?? cfg.openaiCompat.token,
        approval: cfg.openaiCompat.approval
      };
      if (!req.token && req.token !== undefined) delete cfg.openaiCompat.token;
    });
    const cfg = config.get().cfg;
    return { enabled: cfg.openaiCompat.enabled, token: cfg.openaiCompat.token };
  }

  return { getOpenaiCompat, setOpenaiCompat };
}
