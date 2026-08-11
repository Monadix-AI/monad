import type { MonadPaths } from '@monad/environment';
import type {
  DeveloperSettings,
  GetLiveEventReplayFramesQuery,
  ListLiveEventReplayCapturesResponse,
  LiveEventReplayFramePage,
  LogCleanupPreview,
  LogCleanupResult,
  MeshSessionId,
  PreviewLogCleanupRequest,
  SetDeveloperSettingsRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';
import type { LogMaintenanceService } from '#/services/log-maintenance.ts';
import type { MeshAgentHost } from '#/services/mesh-agent/host/index.ts';

import { HandlerError } from '#/handlers/handler-error.ts';
import { developerLogsDir } from '#/services/developer-log.ts';

type DeveloperLogMaintenance = Pick<LogMaintenanceService, 'clearAll' | 'preview'>;

export function createDeveloperModule(
  paths: MonadPaths,
  config: ConfigAccess,
  logMaintenance: DeveloperLogMaintenance,
  meshAgentHost?: Pick<MeshAgentHost, 'listLiveEventReplayCaptures' | 'liveEventReplayFrames'>
) {
  function requireDeveloperMode(purpose = 'access live event logs'): void {
    if (config.get().cfg.developerMode !== true) {
      throw new HandlerError('forbidden', `Developer Mode must be enabled to ${purpose}`);
    }
  }
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
    requireDeveloperMode('clear logs');
    return logMaintenance.clearAll();
  }

  async function listLiveEvents(): Promise<ListLiveEventReplayCapturesResponse> {
    requireDeveloperMode();
    return { captures: (await meshAgentHost?.listLiveEventReplayCaptures()) ?? [] };
  }

  async function getLiveEventFrames(args: {
    meshSessionId: MeshSessionId;
    observationEpoch: string;
    query: GetLiveEventReplayFramesQuery;
  }): Promise<LiveEventReplayFramePage> {
    requireDeveloperMode();
    const page = await meshAgentHost?.liveEventReplayFrames(args.meshSessionId, args.observationEpoch, args.query);
    if (!page) throw new HandlerError('not_found', 'Live event capture not found');
    return page;
  }

  return {
    clearLogs,
    getDeveloperSettings,
    getLiveEventFrames,
    listLiveEvents,
    previewLogCleanup,
    setDeveloperSettings
  };
}
