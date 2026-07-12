import type { MonadPaths } from '@monad/home';
import type { BrowserPresetResponse, SetBrowserPresetRequest } from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createBrowserPresetModule(paths: MonadPaths, configReloader?: ConfigReloader) {
  async function getBrowserPreset(): Promise<BrowserPresetResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('browser-preset: config.json missing');
    const b = cfg.browser;
    return {
      enabled: b.enabled,
      headless: b.headless,
      vision: b.vision,
      engine: b.engine,
      device: b.device,
      command: b.command,
      args: b.args,
      autoApproveReadOnly: b.autoApproveReadOnly
    };
  }

  async function setBrowserPreset(req: SetBrowserPresetRequest): Promise<BrowserPresetResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('browser-preset: config.json missing');

    if (req.enabled !== undefined) cfg.browser.enabled = req.enabled;
    if (req.headless !== undefined) cfg.browser.headless = req.headless;
    if (req.vision !== undefined) cfg.browser.vision = req.vision;
    if (req.engine !== undefined) cfg.browser.engine = req.engine ?? undefined;
    if (req.device !== undefined) cfg.browser.device = req.device ?? undefined;
    if (req.command !== undefined) cfg.browser.command = req.command ?? undefined;
    if (req.args !== undefined) cfg.browser.args = req.args ?? undefined;
    if (req.autoApproveReadOnly !== undefined) cfg.browser.autoApproveReadOnly = req.autoApproveReadOnly;

    await saveProfile(paths.profile, cfg);
    if (configReloader) {
      await configReloader.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
    return getBrowserPreset();
  }

  return { getBrowserPreset, setBrowserPreset };
}
