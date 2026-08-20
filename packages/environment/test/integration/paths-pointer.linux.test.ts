import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPaths } from '../../src/paths.ts';
import { pointerFixture } from './paths-pointer-fixture.ts';

test('the root pointer overrides the XDG default', async () => {
  const fixture = await pointerFixture();
  try {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    const custom = join(tmpdir(), `monad-linux-ptr-${Date.now()}`);
    fixture.write(custom);
    expect(getPaths()).toMatchObject({ home: custom, config: join(custom, 'configs', 'config.json') });
  } finally {
    await fixture.restore();
  }
});

test('XDG_DATA_HOME is used when no root pointer exists', async () => {
  const fixture = await pointerFixture();
  try {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    Bun.env.XDG_DATA_HOME = join(tmpdir(), 'xdg-data-ptr-test');
    await fixture.remove();
    expect(getPaths().home).toBe(join(Bun.env.XDG_DATA_HOME, 'monad'));
  } finally {
    await fixture.restore();
  }
});
