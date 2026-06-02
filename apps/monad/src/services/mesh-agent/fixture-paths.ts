import type { MonadPaths } from '@monad/environment';

import { join } from 'node:path';

export function meshFixtureCaptureDirectory(paths: Pick<MonadPaths, 'logs'>): string {
  return join(paths.logs, 'mesh-agent-fixture-capture');
}
