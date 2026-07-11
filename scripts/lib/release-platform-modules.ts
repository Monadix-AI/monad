import type { PlatformModuleRule } from './platform-modules.ts';

import { join, resolve } from 'node:path';

export function sandboxPlatformModuleRule(root: string): PlatformModuleRule {
  const sandbox = join(resolve(root), 'packages/sandbox/src');
  return {
    seam: join(sandbox, 'light-platform.ts'),
    targets: {
      darwin: join(sandbox, 'light-platform.darwin.ts'),
      linux: join(sandbox, 'light-platform.linux.ts'),
      windows: join(sandbox, 'light-platform.windows.ts')
    }
  };
}
