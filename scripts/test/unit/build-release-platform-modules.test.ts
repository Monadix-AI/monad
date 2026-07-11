import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

import { releasePlatformModuleRules } from '../../lib/release-platform-modules.ts';

test('release maps every platform seam to an explicit module for every target OS', () => {
  const root = resolve('/repo');

  expect(releasePlatformModuleRules(root)).toEqual([
    {
      seam: join(root, 'packages/sandbox/src/sandbox-platform.ts'),
      targets: {
        darwin: join(root, 'packages/sandbox/src/sandbox-platform.darwin.ts'),
        linux: join(root, 'packages/sandbox/src/sandbox-platform.linux.ts'),
        windows: join(root, 'packages/sandbox/src/sandbox-platform.windows.ts')
      }
    },
    {
      seam: join(root, 'packages/home/src/host-platform.ts'),
      targets: {
        darwin: join(root, 'packages/home/src/host-platform.darwin.ts'),
        linux: join(root, 'packages/home/src/host-platform.linux.ts'),
        windows: join(root, 'packages/home/src/host-platform.windows.ts')
      }
    },
    {
      seam: join(root, 'apps/monad/src/handlers/settings/startup/startup-platform.ts'),
      targets: {
        darwin: join(root, 'apps/monad/src/handlers/settings/startup/startup-platform.darwin.ts'),
        linux: join(root, 'apps/monad/src/handlers/settings/startup/startup-platform.linux.ts'),
        windows: join(root, 'apps/monad/src/handlers/settings/startup/startup-platform.windows.ts')
      }
    }
  ]);
});
