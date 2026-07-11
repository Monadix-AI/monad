import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

import { sandboxPlatformModuleRule } from '../../lib/release-platform-modules.ts';

test('release maps the sandbox seam to an explicit module for every target OS', () => {
  const root = resolve('/repo');

  expect(sandboxPlatformModuleRule(root)).toEqual({
    seam: join(root, 'packages/sandbox/src/light-platform.ts'),
    targets: {
      darwin: join(root, 'packages/sandbox/src/light-platform.darwin.ts'),
      linux: join(root, 'packages/sandbox/src/light-platform.linux.ts'),
      windows: join(root, 'packages/sandbox/src/light-platform.windows.ts')
    }
  });
});
