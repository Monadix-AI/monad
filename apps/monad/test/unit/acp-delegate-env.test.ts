// adapterSpawnEnv: the env + writable-roots an external ACP adapter is spawned with.
// Covers the nested-session env scrub and the `osSandbox` credential-dir workaround (so OS-jailing the
// adapter doesn't hide the user's real ~/.codex / ~/.claude login state behind the sandbox HOME redirect).

import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { adapterSpawnEnv } from '#/services/delegation/acp-delegate.ts';

const spec = (osSandbox: boolean) => ({
  name: 'x',
  command: 'npx',
  args: [],
  enabled: true,
  osSandbox,
  forwardMcp: false
});

test('strips Claude Code session markers regardless of osSandbox', () => {
  for (const osSandbox of [false, true]) {
    const { env } = adapterSpawnEnv(spec(osSandbox), {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PATH: '/usr/bin'
    });
    // PATH is now prepended with node bin dirs (nvm/homebrew) so adapters can find npx regardless of
    // how the daemon was launched; the original PATH must still be present.
    expect(typeof env.PATH).toBe('string');
    expect(env.PATH ?? '').toMatch(/\/usr\/bin$/);
  }
});

test('osSandbox off → no credential-dir injection, no extra writable roots', () => {
  const { env, credentialDirs } = adapterSpawnEnv(spec(false), {});
  expect(env.CODEX_HOME).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(credentialDirs).toEqual([]);
});

test('osSandbox on → pins config dirs to the REAL home and exposes them as writable roots', () => {
  const { env, credentialDirs } = adapterSpawnEnv(spec(true), {});
  const codexHome = join(homedir(), '.codex');
  const claudeDir = join(homedir(), '.claude');
  expect(env.CODEX_HOME).toBe(codexHome);
  expect(env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
  expect(credentialDirs).toEqual([codexHome, claudeDir]); // so the adapter can also write session state
});

test('an explicit operator-set CODEX_HOME wins over the injected default', () => {
  const { env } = adapterSpawnEnv(spec(true), { CODEX_HOME: '/custom/codex' });
  expect(env.CODEX_HOME).toBe('/custom/codex');
  expect(env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), '.claude')); // the unset one still gets the default
});
