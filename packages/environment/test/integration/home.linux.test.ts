import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getPaths, xdgPaths } from '../../src/paths.ts';

describe('getPaths', () => {
  const env = { ...Bun.env };

  afterEach(() => {
    Object.assign(Bun.env, env);
    for (const key of ['MONAD_HOME', 'NODE_ENV']) {
      if (!(key in env)) delete Bun.env[key];
    }
  });

  test('production default on Linux is the XDG layout for a fresh install', () => {
    if (existsSync(join(homedir(), '.monad'))) return;
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;

    expect(getPaths()).toEqual(xdgPaths());
  });
});

describe('xdgPaths', () => {
  const env = { ...Bun.env };

  afterEach(() => {
    Object.assign(Bun.env, env);
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
      if (!(key in env)) delete Bun.env[key];
      // biome-ignore lint/style/noNonNullAssertion: key existence verified by `in` check above
      else Bun.env[key] = env[key]!;
    }
  });

  test('respects XDG_DATA_HOME for home, db, atoms, agents, workspace', () => {
    Bun.env.XDG_DATA_HOME = '/xdg/data';
    const p = xdgPaths();
    expect(p.home).toBe('/xdg/data/monad');
    expect(p.dbDir).toBe('/xdg/data/monad/db');
    expect(p.db).toBe('/xdg/data/monad/db/monad.sqlite');
    expect(p.atoms).toBe('/xdg/data/monad/atoms');
    expect(p.agents).toBe('/xdg/data/monad/agents');
    expect(p.workspace).toBe('/xdg/data/monad/agents/default');
  });

  test('respects XDG_CONFIG_HOME for configs, config, profile, auth', () => {
    Bun.env.XDG_CONFIG_HOME = '/xdg/config';
    const p = xdgPaths();
    expect(p.configs).toBe('/xdg/config/monad');
    expect(p.config).toBe('/xdg/config/monad/config.json');
    expect(p.agentsConfig).toBe('/xdg/config/monad/agents.json');
    expect(p.mesh).toBe('/xdg/config/monad/mesh.json');
    expect(p.auth).toBe('/xdg/config/monad/auth.json');
    expect(p.credentials).toBe('/xdg/config/monad/credentials');
    expect(p.tls).toBe('/xdg/config/monad/credentials/tls');
  });

  test('respects XDG_CACHE_HOME for cache', () => {
    Bun.env.XDG_CACHE_HOME = '/xdg/cache';
    const p = xdgPaths();
    expect(p.cache).toBe('/xdg/cache/monad');
  });

  test('respects XDG_RUNTIME_DIR for runtime, sock, kvSock, pid', () => {
    Bun.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const p = xdgPaths();
    expect(p.runtime).toBe('/run/user/1000/monad');
    expect(p.sock).toBe('/run/user/1000/monad/monad.sock');
    expect(p.kvSock).toBe('/run/user/1000/monad/kv.sock');
    expect(p.pid).toBe('/run/user/1000/monad/monad.pid');
  });

  test('falls back to XDG_STATE_HOME for runtime when XDG_RUNTIME_DIR is unset', () => {
    delete Bun.env.XDG_RUNTIME_DIR;
    Bun.env.XDG_STATE_HOME = '/xdg/state';
    const p = xdgPaths();
    expect(p.runtime).toBe('/xdg/state/monad');
    expect(p.sock).toBe('/xdg/state/monad/monad.sock');
  });

  test('falls back to ~/.local/state when XDG_STATE_HOME and XDG_RUNTIME_DIR are unset', () => {
    delete Bun.env.XDG_RUNTIME_DIR;
    delete Bun.env.XDG_STATE_HOME;
    const p = xdgPaths();
    expect(p.runtime).toBe(join(homedir(), '.local', 'state', 'monad'));
  });

  test('XDG layout places sock under runtime, not home', () => {
    Bun.env.XDG_DATA_HOME = '/xdg/data';
    Bun.env.XDG_RUNTIME_DIR = '/run/user/1000';
    const p = xdgPaths();
    expect(p.sock.startsWith('/run/user/1000')).toBe(true);
    expect(p.sock.startsWith('/xdg/data')).toBe(false);
  });
});
