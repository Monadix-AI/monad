import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getRootPointerPath } from '../../src/paths.ts';

test('the root pointer lives under the current home directory', () => {
  const currentHome = Bun.env.HOME || Bun.env.USERPROFILE || homedir();
  expect(getRootPointerPath()).toBe(join(currentHome, '.monad', 'root'));
});
