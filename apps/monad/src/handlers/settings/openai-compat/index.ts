import type { MonadPaths } from '@monad/home';
import type { OpenaiCompatSettings, SetOpenaiCompatRequest } from '@monad/protocol';

import { loadAll, saveProfile } from '@monad/home';

export function createOpenaiCompatModule(paths: MonadPaths) {
  async function getOpenaiCompat(): Promise<OpenaiCompatSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    return {
      enabled: cfg?.openaiCompat?.enabled ?? false,
      token: cfg?.openaiCompat?.token
    };
  }

  async function setOpenaiCompat(req: SetOpenaiCompatRequest): Promise<OpenaiCompatSettings> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('openai-compat settings: config missing');
    // Preserve the inbound approval policy — this panel only edits enabled/token.
    cfg.openaiCompat = {
      enabled: req.enabled,
      token: req.token ?? cfg.openaiCompat?.token,
      approval: cfg.openaiCompat?.approval ?? 'local'
    };
    if (!req.token && req.token !== undefined) delete cfg.openaiCompat.token;
    await saveProfile(paths.profile, cfg);
    return { enabled: cfg.openaiCompat.enabled, token: cfg.openaiCompat.token };
  }

  return { getOpenaiCompat, setOpenaiCompat };
}
