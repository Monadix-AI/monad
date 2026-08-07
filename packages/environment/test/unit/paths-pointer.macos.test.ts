import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { getPaths } from '../../src/paths.ts';
import { pointerFixture } from './paths-pointer-fixture.ts';

test('a corrupt root pointer falls back to the macOS single-tree home', async () => {
  const fixture = await pointerFixture();
  try {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    fixture.write('relative/bad');
    expect(getPaths().home).toBe(join(fixture.fakeHome, '.monad'));
  } finally {
    await fixture.restore();
  }
});
