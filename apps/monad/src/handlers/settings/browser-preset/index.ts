import type { BrowserPresetResponse, SetBrowserPresetRequest } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

export function createBrowserPresetModule(config: ConfigAccess) {
  async function getBrowserPreset(): Promise<BrowserPresetResponse> {
    const cfg = config.get().cfg;
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
    await config.updateConfig((cfg) => {
      if (req.enabled !== undefined) cfg.browser.enabled = req.enabled;
      if (req.headless !== undefined) cfg.browser.headless = req.headless;
      if (req.vision !== undefined) cfg.browser.vision = req.vision;
      if (req.engine !== undefined) cfg.browser.engine = req.engine ?? undefined;
      if (req.device !== undefined) cfg.browser.device = req.device ?? undefined;
      if (req.command !== undefined) cfg.browser.command = req.command ?? undefined;
      if (req.args !== undefined) cfg.browser.args = req.args ?? undefined;
      if (req.autoApproveReadOnly !== undefined) cfg.browser.autoApproveReadOnly = req.autoApproveReadOnly;
    });
    return getBrowserPreset();
  }

  return { getBrowserPreset, setBrowserPreset };
}
