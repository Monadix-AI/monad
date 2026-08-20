import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getPaths, getRootPointerPath } from '../../src/paths.ts';
import { pointerFixture } from './paths-pointer-fixture.ts';

test('the root pointer lives under APPDATA', () => {
  const appData = Bun.env.APPDATA ?? join(Bun.env.HOME || Bun.env.USERPROFILE || homedir(), 'AppData', 'Roaming');
  expect(getRootPointerPath()).toBe(join(appData, 'monad', 'root'));
});

test('a corrupt root pointer falls back to the APPDATA single-tree home', async () => {
  const fixture = await pointerFixture();
  try {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    fixture.write('relative/bad');
    expect(getPaths().home).toBe(join(Bun.env.APPDATA as string, 'monad'));
  } finally {
    await fixture.restore();
  }
});
