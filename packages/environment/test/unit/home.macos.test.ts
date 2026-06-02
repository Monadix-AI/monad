if (process.platform !== 'darwin') process.exit(0);

import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getPaths } from '../../src/paths.ts';

describe('getPaths', () => {
  const env = { ...Bun.env };

  afterEach(() => {
    Object.assign(Bun.env, env);
    for (const key of ['MONAD_HOME', 'NODE_ENV']) {
      if (!(key in env)) delete Bun.env[key];
    }
  });

  test('production default on macOS is the single tree under ~/.monad', () => {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;

    const p = getPaths();
    const expected = join(homedir(), '.monad');

    expect(p.home).toBe(expected);
    expect(p.runtime).toBe(join(expected, 'runtime'));
    expect(p.config).toBe(join(expected, 'configs', 'config.json'));
    expect(p.auth).toBe(join(expected, 'credentials', 'auth.json'));
    expect(p.workspace).toBe(join(expected, 'agents', 'default'));
    expect(p.db).toBe(join(expected, 'db', 'monad.sqlite'));
    expect(p.sock).toBe(join(expected, 'runtime', 'monad.sock'));
  });
});
