import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { mergeMeshAgentChildEnv, meshAgentStripKeys, resolveMeshAgentEnv } from '#/services/mesh-agent/env.ts';
import { buildMeshAgentSpawnEnv } from '#/services/mesh-agent/spawn-support.ts';

const touched: string[] = [];
function setEnv(key: string, value: string): void {
  touched.push(key);
  Bun.env[key] = value;
}
afterEach(() => {
  for (const key of touched.splice(0)) delete Bun.env[key];
});

test('mergeMeshAgentChildEnv strips nested-session markers from the parent env', () => {
  setEnv('CLAUDECODE', '1');
  setEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
  const env = mergeMeshAgentChildEnv();
  expect('CLAUDECODE' in env).toBe(false);
  expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false);
});

test('mergeMeshAgentChildEnv drops injection-vector keys from the agent env (case-insensitive)', () => {
  const env = mergeMeshAgentChildEnv({
    LD_PRELOAD: '/evil.so',
    dyld_insert_libraries: '/evil.dylib',
    NODE_OPTIONS: '--require /evil',
    MY_TOKEN: 'keep-me'
  });
  expect('LD_PRELOAD' in env).toBe(false);
  expect('dyld_insert_libraries' in env).toBe(false);
  expect('NODE_OPTIONS' in env).toBe(false);
  expect(env.MY_TOKEN).toBe('keep-me');
});

test('mergeMeshAgentChildEnv lets agent env override inherited parent keys', () => {
  setEnv('NCLI_TEST_OVERRIDE', 'parent');
  const env = mergeMeshAgentChildEnv({ NCLI_TEST_OVERRIDE: 'agent' });
  expect(env.NCLI_TEST_OVERRIDE).toBe('agent');
});

test('mergeMeshAgentChildEnv makes shebang runtimes available to daemon-launched CLIs', () => {
  const env = mergeMeshAgentChildEnv({ PATH: '/usr/bin' });
  expect((env.PATH ?? '').split(delimiter).slice(-7)).toEqual([
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), 'Library', 'pnpm'),
    '/usr/bin'
  ]);
});

test('mergeMeshAgentChildEnv keeps loader keys inherited from the daemon env', () => {
  setEnv('PYTHONPATH', '/opt/user/lib/python');
  setEnv('NODE_PATH', '/opt/user/lib/node');
  const env = mergeMeshAgentChildEnv();
  // The injection denylist is a WRITE permission on operator config, not a property of the result:
  // a developer's own toolchain paths must still reach the child CLI.
  expect(env.PYTHONPATH).toBe('/opt/user/lib/python');
  expect(env.NODE_PATH).toBe('/opt/user/lib/node');
});

test('mergeMeshAgentChildEnv strips daemon-forbidden keys the agent env tries to reintroduce', () => {
  const env = mergeMeshAgentChildEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  expect('CLAUDECODE' in env).toBe(false); // presence-ok: absence is the invariant under test
  expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false); // presence-ok: absence is the invariant under test
});

test('mergeMeshAgentChildEnv strips adapter- and delivery-declared keys from every source', () => {
  setEnv('NCLI_TEST_FROM_PARENT', 'parent');
  const env = mergeMeshAgentChildEnv(
    { NCLI_TEST_FROM_AGENT: 'agent', NCLI_TEST_KEPT: 'keep-me' },
    meshAgentStripKeys({ strip: ['NCLI_TEST_FROM_PARENT'] }, { strip: ['NCLI_TEST_FROM_AGENT'] })
  );
  expect('NCLI_TEST_FROM_PARENT' in env).toBe(false); // presence-ok: absence is the invariant under test
  expect('NCLI_TEST_FROM_AGENT' in env).toBe(false); // presence-ok: absence is the invariant under test
  expect(env.NCLI_TEST_KEPT).toBe('keep-me');
});

test('buildMeshAgentSpawnEnv applies the adapter policy on the native path', async () => {
  setEnv('NCLI_TEST_ADAPTER_STRIP', 'parent');
  const adapter = { environment: { strip: ['NCLI_TEST_ADAPTER_STRIP'] } } as unknown as MeshAgentProviderAdapter;
  const env = await buildMeshAgentSpawnEnv(undefined, adapter, { NCLI_TEST_KEPT: 'keep-me' });
  expect('NCLI_TEST_ADAPTER_STRIP' in env).toBe(false); // presence-ok: absence is the invariant under test
  expect(env.NCLI_TEST_KEPT).toBe('keep-me');
});

test('buildMeshAgentSpawnEnv still applies daemon invariants for an adapter with no policy', async () => {
  setEnv('CLAUDECODE', '1');
  const env = await buildMeshAgentSpawnEnv(undefined, {} as unknown as MeshAgentProviderAdapter);
  expect('CLAUDECODE' in env).toBe(false); // presence-ok: absence is the invariant under test
});

test('meshAgentStripKeys unions every policy and cannot drop a daemon invariant', () => {
  expect([...meshAgentStripKeys({ strip: ['ADAPTER_KEY'] }, { strip: ['DELIVERY_KEY'] })].sort()).toEqual([
    'ADAPTER_KEY',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'DELIVERY_KEY'
  ]);
  // An adapter declaring nothing still gets the daemon set; there is no subtractive form to test.
  expect([...meshAgentStripKeys(undefined, undefined)].sort()).toEqual(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']);
});

const envRef = (name: string) => `\${env:${name}}`;
const secretRef = (name: string) => `\${secret:${name}}`;

test('resolveMeshAgentEnv resolves env refs and passes plain values through', () => {
  setEnv('NCLI_TEST_KEY', 'sk-resolved');
  const resolved = resolveMeshAgentEnv({ API_KEY: envRef('NCLI_TEST_KEY'), PLAIN: 'literal' }, undefined);
  expect(resolved).toEqual({ API_KEY: 'sk-resolved', PLAIN: 'literal' });
});

test('resolveMeshAgentEnv rejects legacy secret refs and drops unresolvable environment refs', () => {
  const resolved = resolveMeshAgentEnv(
    { TOKEN: secretRef('MY_SECRET'), MISSING: envRef('NCLI_DEFINITELY_UNSET') },
    undefined
  );
  expect(resolved).toBeUndefined();
});

test('resolveMeshAgentEnv returns undefined for empty/undefined env', () => {
  expect(resolveMeshAgentEnv(undefined, undefined)).toBeUndefined();
  expect(resolveMeshAgentEnv({}, undefined)).toBeUndefined();
});
