import type { MonadPaths } from '@monad/environment';
import type {
  DeveloperSettings,
  LogCleanupPreview,
  LogCleanupResult,
  PreviewLogCleanupRequest,
  SetDeveloperSettingsRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';
import type { LogMaintenanceService } from '#/services/log-maintenance.ts';

import { HandlerError } from '#/handlers/handler-error.ts';
import { developerLogsDir } from '#/services/developer-log.ts';

type DeveloperLogMaintenance = Pick<LogMaintenanceService, 'clearAll' | 'preview'>;

export function createDeveloperModule(
  paths: MonadPaths,
  config: ConfigAccess,
  logMaintenance: DeveloperLogMaintenance
) {
  async function getDeveloperSettings(): Promise<DeveloperSettings> {
    const cfg = config.get().cfg;
    return {
      developerMode: cfg.developerMode === true,
      logsDir: developerLogsDir(paths),
      logs: { autoCleanup: cfg.logs.autoCleanup }
    };
  }

  async function setDeveloperSettings(req: SetDeveloperSettingsRequest): Promise<DeveloperSettings> {
    await config.updateConfig((cfg) => {
      if (req.developerMode !== undefined) cfg.developerMode = req.developerMode;
      if (req.logs?.autoCleanup !== undefined) cfg.logs.autoCleanup = req.logs.autoCleanup;
    });
    return getDeveloperSettings();
  }

  async function previewLogCleanup(policy: PreviewLogCleanupRequest): Promise<LogCleanupPreview> {
    return logMaintenance.preview(policy);
  }

  async function clearLogs(): Promise<LogCleanupResult> {
    if (config.get().cfg.developerMode !== true) {
      throw new HandlerError('forbidden', 'Developer Mode must be enabled to clear logs');
    }
    return logMaintenance.clearAll();
  }

  return { clearLogs, getDeveloperSettings, previewLogCleanup, setDeveloperSettings };
}
