// adapterSpawnEnv: the env + writable-roots an external ACP adapter is spawned with.
// Covers the nested-session env scrub and the `osSandbox` credential-dir workaround (so OS-jailing the
// adapter doesn't hide the user's real ~/.codex / ~/.claude login state behind the sandbox HOME redirect).

import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { adapterSpawnEnv } from '#/services/delegation/acp-delegate.ts';
import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';

for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

const spec = (osSandbox: boolean, name = 'x') => ({
  name,
  command: 'npx',
  args: [],
  enabled: true,
  osSandbox,
  forwardMcp: false
});

test('ACP spawn env applies only the selected adapter credential policy', () => {
  const codexHome = join(homedir(), '.codex');
  const { env, credentialDirs } = adapterSpawnEnv(spec(true, 'codex'), {});
  expect(env).toMatchObject({ CODEX_HOME: codexHome });
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(credentialDirs).toEqual([codexHome]);
});

// The nested-session markers leak from the daemon's OWN parent session, so they are a daemon-wide
// invariant rather than the Claude adapter's policy: every provider's child must lose them.
test.each(['codex', 'claude-code'])('ACP spawn env strips nested-session markers for %s', (name) => {
  for (const osSandbox of [false, true]) {
    const { env } = adapterSpawnEnv(spec(osSandbox, name), {
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PATH: '/usr/bin'
    });
    expect('CLAUDECODE' in env).toBe(false); // presence-ok: absence is the invariant under test
    expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false); // presence-ok: absence is the invariant under test
    // PATH is prepended with node bin dirs (nvm/homebrew) so adapters can find npx regardless of how
    // the daemon was launched; the original PATH must still be present.
    expect(env.PATH ?? '').toMatch(/\/usr\/bin$/);
  }
});

test('osSandbox off → no credential-dir injection, no extra writable roots', () => {
  const { env, credentialDirs } = adapterSpawnEnv(spec(false), {});
  expect(env.CODEX_HOME).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(credentialDirs).toEqual([]);
});

test('osSandbox exposes only the selected adapter credential directory', () => {
  const codexHome = join(homedir(), '.codex');
  const claudeDir = join(homedir(), '.claude');
  expect(adapterSpawnEnv(spec(true, 'codex'), {})).toMatchObject({
    env: { CODEX_HOME: codexHome },
    credentialDirs: [codexHome]
  });
  expect(adapterSpawnEnv(spec(true, 'claude-code'), {})).toMatchObject({
    env: { CLAUDE_CONFIG_DIR: claudeDir },
    credentialDirs: [claudeDir]
  });
});

test('an explicit operator-set CODEX_HOME wins over the injected default', () => {
  const { env, credentialDirs } = adapterSpawnEnv(spec(true, 'codex'), { CODEX_HOME: '/custom/codex' });
  expect(env.CODEX_HOME).toBe('/custom/codex');
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(credentialDirs).toEqual([join(homedir(), '.codex')]);
});
