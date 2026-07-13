import type { MonadPaths } from '@monad/home';
import type {
  ActivateSandboxBackendRequest,
  SandboxActivationResult,
  SandboxSettingsResponse,
  SetSandboxSettingsRequest
} from '@monad/protocol';
import type { ConfigReloader } from '#/config/reloader.ts';
import type { SandboxActivationService } from '#/platform/sandbox/activation.ts';

import { emptyAuth, loadAll, loadAuth, saveAuth, saveSandbox, saveSystemConfig } from '@monad/home';
import { listSandboxBackendDescriptors } from '@monad/sandbox';

import { createFileSandboxActivationService } from '#/platform/sandbox/activation.ts';
import {
  applyBackendSettingsUpdate,
  redactBackendSettings,
  serializeSandboxBackendRef
} from '#/platform/sandbox/backend-settings.ts';

// System-level sandbox POLICY (cfg.sandbox, persisted to sandbox.json) + the global ceiling
// (cfg.agent.globalSandbox, persisted to config.json). HTTP-only settings surface. The policy block
// lives in its own file, so persist it via saveSandbox; globalSandbox stays in the system config, so
// persist it via saveSystemConfig. The renderable subset only — env/seedTemplate/initScript/
// launcherPath stay file-only. Applies on the next daemon restart for boot-time confinement
// (launcher/net/proxy), like the other system settings.
export function createSandboxModule(
  paths: MonadPaths,
  configReloader?: ConfigReloader,
  activationService: SandboxActivationService = createFileSandboxActivationService(paths, configReloader)
) {
  async function getSandboxSettings(): Promise<SandboxSettingsResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('sandbox: config.json missing');
    const auth = (await loadAuth(paths.auth)) ?? emptyAuth();
    const { mode, confine, net, allowedDomains, hostExec } = cfg.sandbox;
    const descriptors = new Map(
      listSandboxBackendDescriptors().map((backend) => [serializeSandboxBackendRef(backend.ref), backend.descriptor])
    );
    const backendSettings = redactBackendSettings(cfg.sandbox.backendSettings, auth, descriptors);
    const backends = listSandboxBackendDescriptors().map((backend) => {
      const key = serializeSandboxBackendRef(backend.ref);
      const settings = { ...(backendSettings[key] ?? {}) };
      for (const field of backend.descriptor.settings?.fields ?? []) {
        if (settings[field.id] === undefined && field.type === 'secret') settings[field.id] = { configured: false };
        else if (settings[field.id] === undefined && field.type !== 'secret' && field.defaultValue !== undefined)
          settings[field.id] = field.defaultValue;
      }
      const active = key === serializeSandboxBackendRef(cfg.sandbox.activeBackend);
      return {
        ref: backend.ref,
        descriptor: backend.descriptor,
        sourceLabel: backend.ref.source === 'builtin' ? 'Built-in' : backend.ref.packId,
        ...(backend.platforms ? { platforms: backend.platforms } : {}),
        ...(backend.enforces ? { enforces: backend.enforces } : {}),
        status: active ? ('active' as const) : backend.available ? ('available' as const) : ('unavailable' as const),
        settings
      };
    });
    return {
      sandbox: { mode, confine, net, allowedDomains, hostExec },
      globalSandbox: { enabled: cfg.agent.globalSandbox.enabled, mode: cfg.agent.globalSandbox.mode },
      activeBackend: cfg.sandbox.activeBackend,
      backendSettings,
      backends
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

    let auth = (await loadAuth(paths.auth)) ?? emptyAuth();
    if (req.backendSettings) {
      const key = serializeSandboxBackendRef(req.backendSettings.ref);
      const backend = listSandboxBackendDescriptors().find(
        (candidate) => serializeSandboxBackendRef(candidate.ref) === key
      );
      if (!backend) throw new Error(`sandbox backend "${key}" is not registered`);
      const applied = applyBackendSettingsUpdate(
        cfg.sandbox.backendSettings,
        auth,
        backend.descriptor,
        req.backendSettings
      );
      cfg.sandbox.backendSettings = applied.backendSettings;
      auth = applied.auth;
      if (applied.authChanged) await saveAuth(paths.auth, auth);
    }

    if (req.sandbox || req.backendSettings) await saveSandbox(paths.sandbox, cfg);
    if (req.globalSandbox) await saveSystemConfig(paths.config, cfg);
    if (configReloader) {
      await configReloader.publish({ cfg, auth });
    }
    return getSandboxSettings();
  }

  async function activateSandboxBackend(req: ActivateSandboxBackendRequest): Promise<SandboxActivationResult> {
    return activationService.activateBackend(req.ref, req.settings);
  }

  return { getSandboxSettings, setSandboxSettings, activateSandboxBackend };
}
