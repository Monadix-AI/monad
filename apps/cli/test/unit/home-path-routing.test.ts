// Verify that CLI path helpers route to the correct on-disk locations when
// MONAD_HOME is changed. skill.ts now delegates create/remove to the daemon,
// so skill path-routing is verified by writing files directly at paths.skills.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, initMonadHome } from '@monad/home';

const env = { ...Bun.env };
let testHome: string;

beforeEach(async () => {
  testHome = join(tmpdir(), `monad-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  Bun.env.MONAD_HOME = testHome;
  await initMonadHome(getPaths());
});

afterEach(async () => {
  Object.assign(Bun.env, env);
  if (!('MONAD_HOME' in env)) delete Bun.env.MONAD_HOME;
  await rm(testHome, { recursive: true, force: true });
});

// ── All derived paths change atomically when MONAD_HOME changes ───────────────

describe('getPaths() tracks MONAD_HOME across all sub-paths', () => {
  test('every sub-path is rooted under the custom MONAD_HOME', () => {
    const p = getPaths();
    // Structural correctness: single-tree layout.
    expect(p.home).toBe(testHome);
    expect(p.config).toBe(join(testHome, 'configs', 'config.json'));
    expect(p.auth).toBe(join(testHome, 'credentials', 'auth.json'));
    expect(p.skills).toBe(join(testHome, 'atoms', 'skills'));
    expect(p.atoms).toBe(join(testHome, 'atoms'));
    expect(p.sock).toBe(join(testHome, 'runtime', 'monad.sock'));
    expect(p.db).toBe(join(testHome, 'db', 'monad.sqlite'));
    expect(p.logs).toBe(join(testHome, 'logs'));
    expect(p.workspace).toBe(join(testHome, 'agents', 'default'));
    expect(p.tls).toBe(join(testHome, 'credentials', 'tls'));
    expect(p.pid).toBe(join(testHome, 'runtime', 'monad.pid'));
  });

  test('switching MONAD_HOME immediately changes all derived paths', () => {
    const homeB = join(tmpdir(), `monad-b-${Date.now()}`);
    Bun.env.MONAD_HOME = homeB;

    const p = getPaths();
    expect(p.home).toBe(homeB);
    expect(p.config).toBe(join(homeB, 'configs', 'config.json'));
    expect(p.auth).toBe(join(homeB, 'credentials', 'auth.json'));
    expect(p.skills).toBe(join(homeB, 'atoms', 'skills'));
    expect(p.sock).toBe(join(homeB, 'runtime', 'monad.sock'));
    expect(p.db).toBe(join(homeB, 'db', 'monad.sqlite'));

    // Restore for afterEach.
    Bun.env.MONAD_HOME = testHome;
  });

  test('no sub-path escapes MONAD_HOME to a hardcoded default', () => {
    const defaultHome = join(require('node:os').homedir(), '.monad');
    const p = getPaths();
    // None of the paths should reference the default ~/.monad when MONAD_HOME is set.
    for (const [_key, value] of Object.entries(p)) {
      if (typeof value === 'string') {
        expect(value).not.toContain(defaultHome);
      }
    }
  });
});

// ── paths.skills — path routing (files written directly; skill new/remove are daemon-RPC) ───────

describe('skill path follows MONAD_HOME (paths.skills)', () => {
  test('paths.skills resolves under MONAD_HOME/atoms/skills', () => {
    expect(getPaths().skills).toBe(join(testHome, 'atoms', 'skills'));
  });

  test('file written to paths.skills is isolated per MONAD_HOME', async () => {
    // Write a sentinel file into homeA's skills dir.
    const skillDir = join(getPaths().skills, 'home-a-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# home-a-skill');
    expect(existsSync(join(testHome, 'atoms', 'skills', 'home-a-skill', 'SKILL.md'))).toBe(true);

    // Switch to homeB — the file must NOT appear there.
    const homeB = join(tmpdir(), `monad-skills-b-${Date.now()}`);
    Bun.env.MONAD_HOME = homeB;
    await initMonadHome(getPaths());
    expect(existsSync(join(homeB, 'atoms', 'skills', 'home-a-skill', 'SKILL.md'))).toBe(false);

    await rm(homeB, { recursive: true, force: true });
    Bun.env.MONAD_HOME = testHome;
  });

  test('removing a file from paths.skills reflects in the correct MONAD_HOME', async () => {
    const skillDir = join(getPaths().skills, 'to-remove');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# to-remove');
    expect(existsSync(join(getPaths().skills, 'to-remove', 'SKILL.md'))).toBe(true);

    await rm(join(getPaths().skills, 'to-remove'), { recursive: true });
    expect(existsSync(join(getPaths().skills, 'to-remove'))).toBe(false);
  });
});

// ── paths.atoms — atom pack isolation ────────────────────────────────────────

describe('atom pack path follows MONAD_HOME (paths.atoms)', () => {
  test('paths.atoms is MONAD_HOME/atoms', () => {
    expect(getPaths().atoms).toBe(join(testHome, 'atoms'));
  });

  test('atom pack written to homeA/atoms is absent under homeB', async () => {
    const packDir = join(getPaths().atoms, 'my-pack');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'atom-pack.json'), JSON.stringify({ name: 'my-pack' }));

    const homeB = join(tmpdir(), `monad-atoms-b-${Date.now()}`);
    Bun.env.MONAD_HOME = homeB;
    await initMonadHome(getPaths());

    expect(existsSync(join(getPaths().atoms, 'my-pack', 'atom-pack.json'))).toBe(false);

    Bun.env.MONAD_HOME = testHome;
    await rm(homeB, { recursive: true, force: true });
  });
});
