import type { MonadPaths } from '@monad/environment';
import type { createLogger } from '@monad/logger';
import type { Store } from '#/store/db/index.ts';

import { existsSync } from 'node:fs';

import { pathDelimiterFor } from '#/infra/platform-path.ts';
import { developerLogsDir } from '#/services/developer-log.ts';
import { sweepStaleLogs } from '#/services/log-maintenance.ts';
import { ensureDevProvider } from '#/store/home/dev-init.ts';

type StartupLogger = Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;

export function prependMonadBinToPath(paths: MonadPaths): void {
  if (!existsSync(paths.bin)) return;
  Bun.env.PATH = `${paths.bin}${pathDelimiterFor()}${Bun.env.PATH ?? ''}`;
}

export async function seedDevProviderIfNeeded(deps: {
  paths: MonadPaths;
  useMock: boolean;
  devMode: boolean;
  devSilent: boolean;
  logger: StartupLogger;
}): Promise<void> {
  const { paths, useMock, devMode, devSilent, logger } = deps;
  if ((!devMode && !devSilent) || useMock) return;
  const seeded = await ensureDevProvider(paths);
  if (seeded.seeded) logger.info(`dev: seeded provider from config.init.json (model ${seeded.model})`);
  else if (seeded.reason === 'no-key') logger.warn('dev: no API key in config.init.json — complete setup at /init');
  else if (seeded.reason === 'no-model') logger.warn('dev: no model in config.init.json — complete setup at /init');
}

export function startStartupHousekeeping(deps: { paths: MonadPaths; store: Store; logger: StartupLogger }): void {
  const { paths, store, logger } = deps;

  store.reconcileOrphanedDelegates();

  const pruned = store.pruneOldAcpDelegates();
  if (pruned > 0) logger.info({ pruned }, 'pruned old acp_delegates rows');
  const delegatePruneTimer = setInterval(
    () => {
      const n = store.pruneOldAcpDelegates();
      if (n > 0) logger.info({ pruned: n }, 'pruned old acp_delegates rows');
    },
    24 * 60 * 60 * 1000
  );
  delegatePruneTimer.unref();

  const prunedMeshAgent = store.pruneExitedMeshSessions();
  if (prunedMeshAgent > 0) logger.info({ pruned: prunedMeshAgent }, 'pruned old mesh_sessions rows');
  const meshAgentPruneTimer = setInterval(
    () => {
      const n = store.pruneExitedMeshSessions();
      if (n > 0) logger.info({ pruned: n }, 'pruned old mesh_sessions rows');
    },
    24 * 60 * 60 * 1000
  );
  meshAgentPruneTimer.unref();

  const logsDir = developerLogsDir(paths);
  const runLogSweep = () =>
    void sweepStaleLogs({ logsDir }).then((n) => {
      if (n > 0) logger.info({ removed: n }, 'swept stale logs');
    });
  runLogSweep();
  const logSweepTimer = setInterval(runLogSweep, 24 * 60 * 60 * 1000);
  logSweepTimer.unref();
}
