import type { MonadPaths } from '@monad/home';
import type { SandboxSettingsResponse, SetSandboxSettingsRequest } from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';

import { loadAll, loadAuth, saveSandbox, saveSystemConfig } from '@monad/home';

// System-level sandbox POLICY (cfg.sandbox, persisted to sandbox.json) + the global ceiling
// (cfg.agent.globalSandbox, persisted to config.json). HTTP-only settings surface. The policy block
// lives in its own file, so persist it via saveSandbox; globalSandbox stays in the system config, so
// persist it via saveSystemConfig. The renderable subset only — env/seedTemplate/initScript/
// launcherPath stay file-only. Applies on the next daemon restart for boot-time confinement
// (launcher/net/proxy), like the other system settings.
export function createSandboxModule(paths: MonadPaths, configReloader?: ConfigReloader) {
  async function getSandboxSettings(): Promise<SandboxSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('sandbox: config.json missing');
    const { mode, confine, net, allowedDomains, hostExec } = cfg.sandbox;
    return {
      sandbox: { mode, confine, net, allowedDomains, hostExec },
      globalSandbox: { enabled: cfg.agent.globalSandbox.enabled, mode: cfg.agent.globalSandbox.mode }
    };
  }

  async function setSandboxSettings(req: SetSandboxSettingsRequest): Promise<SandboxSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('sandbox: config.json missing');

    if (req.sandbox) {
      const s = cfg.sandbox;
      if (req.sandbox.mode !== undefined) s.mode = req.sandbox.mode;
      if (req.sandbox.confine !== undefined) s.confine = req.sandbox.confine;
      if (req.sandbox.net !== undefined) s.net = req.sandbox.net;
      if (req.sandbox.allowedDomains !== undefined) s.allowedDomains = req.sandbox.allowedDomains;
      if (req.sandbox.hostExec !== undefined) s.hostExec = req.sandbox.hostExec;
    }
    if (req.globalSandbox) {
      if (req.globalSandbox.enabled !== undefined) cfg.agent.globalSandbox.enabled = req.globalSandbox.enabled;
      if (req.globalSandbox.mode !== undefined) cfg.agent.globalSandbox.mode = req.globalSandbox.mode;
    }

    if (req.sandbox) await saveSandbox(paths.sandbox, cfg);
    if (req.globalSandbox) await saveSystemConfig(paths.config, cfg);
    if (configReloader) {
      await configReloader.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
    return getSandboxSettings();
  }

  return { getSandboxSettings, setSandboxSettings };
}
