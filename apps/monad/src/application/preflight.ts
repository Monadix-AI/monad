import type { MonadPaths } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { DaemonRuntimeFlags } from '#/runtime/flags.ts';

import { join } from 'node:path';
import { getPaths, initMonadHome } from '@monad/environment';

import { daemonChildProcesses, runDaemonChildSupervisorFromArgv } from '#/infra/daemon-child-processes.ts';
import { readDaemonRuntimeFlags } from '#/runtime/flags.ts';
import { acquireDaemonSingletonLock } from '#/runtime/singleton.ts';
import { prependMonadBinToPath, seedDevProviderIfNeeded } from '#/store/home/startup-housekeeping.ts';
import { runAcpBridge } from '#/transports/acp/launch.ts';

export type DaemonMode = 'acp' | 'daemon';

export interface DaemonPreflight {
  paths: MonadPaths;
  flags: DaemonRuntimeFlags;
}

export function resolveDaemonMode(argv: readonly string[]): DaemonMode {
  return argv.includes('--acp') ? 'acp' : 'daemon';
}

export async function runDaemonPreflight(options: {
  supervisorEntryPath: string;
  logger: Logger;
}): Promise<DaemonPreflight | undefined> {
  if (await runDaemonChildSupervisorFromArgv()) return undefined;

  const paths = getPaths();
  if (resolveDaemonMode(process.argv) === 'acp') {
    await runAcpBridge(paths);
    return undefined;
  }

  await acquireDaemonSingletonLock(paths);
  const flags = readDaemonRuntimeFlags();
  await initMonadHome(paths);
  daemonChildProcesses.configure(join(paths.runtime, 'daemon-child-processes.json'), {
    supervisorEntryPath: options.supervisorEntryPath
  });
  prependMonadBinToPath(paths);
  await seedDevProviderIfNeeded({
    paths,
    useMock: flags.useMock,
    devMode: flags.devMode,
    devSilent: flags.devSilent,
    logger: options.logger
  });
  return { paths, flags };
}
