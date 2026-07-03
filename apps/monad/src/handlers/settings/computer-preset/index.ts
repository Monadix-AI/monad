import type { MonadPaths } from '@monad/home';
import type { ComputerPresetResponse, SetComputerPresetRequest } from '@monad/protocol';
import type { ConfigBus } from '@/services/config-bus.ts';

import { loadAll, loadAuth, saveProfile } from '@monad/home';

export function createComputerPresetModule(paths: MonadPaths, configBus?: ConfigBus) {
  async function getComputerPreset(): Promise<ComputerPresetResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('computer-preset: config.json missing');
    const c = cfg.computer;
    return {
      enabled: c.enabled,
      command: c.command,
      args: c.args,
      env: c.env,
      autoApproveReadOnly: c.autoApproveReadOnly
    };
  }

  async function setComputerPreset(req: SetComputerPresetRequest): Promise<ComputerPresetResponse> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('computer-preset: config.json missing');

    if (req.enabled !== undefined) cfg.computer.enabled = req.enabled;
    if (req.command !== undefined) cfg.computer.command = req.command;
    if (req.args !== undefined) cfg.computer.args = req.args;
    if (req.env !== undefined) cfg.computer.env = req.env ?? undefined;
    if (req.autoApproveReadOnly !== undefined) cfg.computer.autoApproveReadOnly = req.autoApproveReadOnly;

    await saveProfile(paths.profile, cfg);
    if (configBus) {
      await configBus.publish({ cfg, auth: await loadAuth(paths.auth) });
    }
    return getComputerPreset();
  }

  return { getComputerPreset, setComputerPreset };
}
