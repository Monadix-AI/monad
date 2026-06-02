import type { PlatformModuleRule } from './platform-modules.ts';

import { join, resolve } from 'node:path';

export function releasePlatformModuleRules(root: string): PlatformModuleRule[] {
  const resolvedRoot = resolve(root);
  return [
    platformRule(join(resolvedRoot, 'packages/sandbox/src'), 'sandbox-platform'),
    platformRule(join(resolvedRoot, 'packages/environment/src'), 'host-platform'),
    platformRule(join(resolvedRoot, 'apps/monad/src/handlers/settings/startup'), 'startup-platform')
  ];
}

function platformRule(directory: string, basename: string): PlatformModuleRule {
  return {
    seam: join(directory, `${basename}.ts`),
    targets: {
      darwin: join(directory, `${basename}.darwin.ts`),
      linux: join(directory, `${basename}.linux.ts`),
      windows: join(directory, `${basename}.windows.ts`)
    }
  };
}
