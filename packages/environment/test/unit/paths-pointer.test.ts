// Tests for getPaths() pointer-file behaviour and getRootPointerPath().
// Separated from home.test.ts to avoid conflicts with staged edits.
// These tests are cross-platform: getRootPointerPath() handles the OS difference
// so the same test body runs on macOS, Linux, and Windows CI.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { getPaths, getRootPointerPath } from '../../src/paths.ts';

// ── getRootPointerPath ────────────────────────────────────────────────────────

describe('getRootPointerPath', () => {
  const env = { ...Bun.env };

  afterEach(() => {
    Object.assign(Bun.env, env);
    if (!('APPDATA' in env)) delete Bun.env.APPDATA;
  });

  test('on non-Windows, pointer lives at ~/.monad/root', () => {
    if (process.platform === 'win32') return;
    expect(getRootPointerPath()).toBe(join(homedir(), '.monad', 'root'));
  });

  test('on Windows, pointer lives under APPDATA/monad/root', () => {
    if (process.platform !== 'win32') return;
    const appData = Bun.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    expect(getRootPointerPath()).toBe(join(appData, 'monad', 'root'));
  });
});

// ── getPaths pointer file ─────────────────────────────────────────────────────

describe('getPaths pointer file', () => {
  const env = { ...Bun.env };
  let originalPointer: string | null = null;
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = join(tmpdir(), `monad-home-ptr-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
    Bun.env.HOME = fakeHome;
    Bun.env.USERPROFILE = fakeHome;
    Bun.env.APPDATA = join(fakeHome, 'AppData', 'Roaming');
    try {
      originalPointer = await Bun.file(getRootPointerPath()).text();
    } catch {
      originalPointer = null;
    }
  });

  afterEach(async () => {
    const ptr = getRootPointerPath();
    if (originalPointer === null) {
      await rm(ptr, { force: true });
    } else {
      await writeFile(ptr, originalPointer);
    }
    await rm(fakeHome, { recursive: true, force: true });
    Object.assign(Bun.env, env);
    for (const key of [
      'MONAD_HOME',
      'NODE_ENV',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
      'HOME',
      'USERPROFILE',
      'APPDATA'
    ]) {
      if (!(key in env)) delete Bun.env[key];
    }
  });

  function writePointer(content: string): void {
    const ptr = getRootPointerPath();
    mkdirSync(dirname(ptr), { recursive: true });
    writeFileSync(ptr, content);
  }

  // ── cross-platform behaviour ─────────────────────────────────────────────

  test('pointer file is honoured on all platforms when MONAD_HOME is unset and not in dev', () => {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;

    const custom = join(tmpdir(), `monad-ptr-${Date.now()}`);
    writePointer(custom);

    const p = getPaths();
    expect(p.home).toBe(custom);
    expect(p.config).toBe(join(custom, 'configs', 'config.json'));
    expect(p.sock).toBe(join(custom, 'runtime', 'monad.sock'));
    expect(p.skills).toBe(join(custom, 'atoms', 'skills'));
  });

  test('MONAD_HOME takes priority over pointer file on all platforms', () => {
    Bun.env.NODE_ENV = 'production';

    const pinned = join(tmpdir(), `monad-pinned-${Date.now()}`);
    const override = join(tmpdir(), `monad-override-${Date.now()}`);
    writePointer(pinned);

    Bun.env.MONAD_HOME = override;
    expect(getPaths().home).toBe(override);
  });

  test('corrupt pointer (non-absolute string) falls through to platform default', () => {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    writePointer('not-an-absolute-path');

    const p = getPaths();
    expect(p.home).not.toBe('not-an-absolute-path');
    expect(isAbsolute(p.home)).toBe(true);
  });

  test('relative path in pointer is ignored (must be absolute)', () => {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    writePointer('../relative/path');

    const p = getPaths();
    expect(p.home).not.toBe('../relative/path');
    expect(isAbsolute(p.home)).toBe(true);
  });

  test('whitespace-only pointer file is ignored', () => {
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    writePointer('   ');

    expect(isAbsolute(getPaths().home)).toBe(true);
  });

  // ── macOS / Windows: single-tree fallback ───────────────────────────────

  test('on macOS, corrupt pointer falls back to ~/.monad', () => {
    if (process.platform !== 'darwin') return;
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    writePointer('relative/bad');

    expect(getPaths().home).toBe(join(fakeHome, '.monad'));
  });

  test('on Windows, corrupt pointer falls back to APPDATA/monad', () => {
    if (process.platform !== 'win32') return;
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    writePointer('relative/bad');

    const appData = Bun.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    expect(getPaths().home).toBe(join(appData, 'monad'));
  });

  // ── Linux: pointer overrides XDG ────────────────────────────────────────

  test('on Linux, pointer file overrides the XDG default', () => {
    if (process.platform !== 'linux') return;
    if (originalPointer !== null) return; // machine already has a pointer file — don't overwrite
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;

    const custom = join(tmpdir(), `monad-linux-ptr-${Date.now()}`);
    writePointer(custom);

    const p = getPaths();
    expect(p.home).toBe(custom);
    expect(p.config).toBe(join(custom, 'configs', 'config.json'));
  });

  test('on Linux, XDG_DATA_HOME is used when no pointer file exists', () => {
    if (process.platform !== 'linux') return;
    if (originalPointer !== null) return; // machine already has a pointer file — don't overwrite
    Bun.env.NODE_ENV = 'production';
    delete Bun.env.MONAD_HOME;
    Bun.env.XDG_DATA_HOME = join(tmpdir(), 'xdg-data-ptr-test');

    expect(getPaths().home).toBe(join(Bun.env.XDG_DATA_HOME, 'monad'));
  });
});
