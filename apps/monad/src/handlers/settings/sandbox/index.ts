import type { MonadPaths } from '@monad/home';
import type { SandboxSettingsResponse, SetSandboxSettingsRequest } from '@monad/protocol';
import type { ConfigBus } from '#/services/config-bus.ts';

import { loadAll, loadAuth, saveSystemConfig } from '@monad/home';

// System-level sandbox defaults (cfg.agent.sandbox) + the global ceiling (cfg.agent.globalSandbox).
// HTTP-only settings surface. Sandbox lives in the SYSTEM slice (mergeConfigs takes agent.sandbox from
// system config, not profile), so persist to config.json via saveSystemConfig — like acp-agents, NOT
// tool-backends (which is profile-overridable). The renderable subset only — env/seedTemplate/
// initScript/launcherPath stay config-file-only. Applies on the next daemon restart for boot-time
// confinement (launcher/net/proxy), like the other system settings.
export function createSandboxModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getSandboxSettings(): Promise<SandboxSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('sandbox: config.json missing');
    const { mode, confine, net, allowedDomains, hostExec } = cfg.agent.sandbox;
    return {
      sandbox: { mode, confine, net, allowedDomains, hostExec },
      globalSandbox: { enabled: cfg.agent.globalSandbox.enabled, mode: cfg.agent.globalSandbox.mode }
    };
  }

  async function setSandboxSettings(req: SetSandboxSettingsRequest): Promise<SandboxSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('sandbox: config.json missing');

    if (req.sandbox) {
      const s = cfg.agent.sandbox;
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

    await saveSystemConfig(paths.config, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
    return getSandboxSettings();
  }

  return { getSandboxSettings, setSandboxSettings };
}
