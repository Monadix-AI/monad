import type { MonadPaths } from '@monad/environment';

import { join } from 'node:path';
import { setDeveloperLogTransport } from '@monad/logger';

export function developerLogsDir(paths: MonadPaths): string {
  return join(paths.home, 'logs');
}

export function configureDeveloperLogTransport(paths: MonadPaths, enabled: boolean): void {
  setDeveloperLogTransport({ enabled, dir: developerLogsDir(paths) });
}
