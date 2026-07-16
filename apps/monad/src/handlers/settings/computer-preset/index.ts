import type { ComputerPresetResponse, SetComputerPresetRequest } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

export function createComputerPresetModule(config: ConfigAccess) {
  async function getComputerPreset(): Promise<ComputerPresetResponse> {
    const cfg = config.get().cfg;
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
    await config.updateConfig((cfg) => {
      if (req.enabled !== undefined) cfg.computer.enabled = req.enabled;
      if (req.command !== undefined) cfg.computer.command = req.command;
      if (req.args !== undefined) cfg.computer.args = req.args;
      if (req.env !== undefined) cfg.computer.env = req.env ?? undefined;
      if (req.autoApproveReadOnly !== undefined) cfg.computer.autoApproveReadOnly = req.autoApproveReadOnly;
    });
    return getComputerPreset();
  }

  return { getComputerPreset, setComputerPreset };
}
