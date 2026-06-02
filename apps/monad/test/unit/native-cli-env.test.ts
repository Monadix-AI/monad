import type { MonadAuth } from '@monad/home';

import { afterEach, expect, test } from 'bun:test';

import { mergeNativeCliChildEnv, resolveNativeCliAgentEnv } from '@/services/native-cli/env.ts';

const touched: string[] = [];
function setEnv(key: string, value: string): void {
  touched.push(key);
  Bun.env[key] = value;
}
afterEach(() => {
  for (const key of touched.splice(0)) delete Bun.env[key];
});

test('mergeNativeCliChildEnv strips nested-session markers from the parent env', () => {
  setEnv('CLAUDECODE', '1');
  setEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
  const env = mergeNativeCliChildEnv();
  expect('CLAUDECODE' in env).toBe(false);
  expect('CLAUDE_CODE_ENTRYPOINT' in env).toBe(false);
});

test('mergeNativeCliChildEnv drops injection-vector keys from the agent env (case-insensitive)', () => {
  const env = mergeNativeCliChildEnv({
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

test('mergeNativeCliChildEnv lets agent env override inherited parent keys', () => {
  setEnv('NCLI_TEST_OVERRIDE', 'parent');
  const env = mergeNativeCliChildEnv({ NCLI_TEST_OVERRIDE: 'agent' });
  expect(env.NCLI_TEST_OVERRIDE).toBe('agent');
});

// Build the literal `${env:NAME}` / `${secret:NAME}` ref syntax via an escaped template literal so it
// isn't flagged as an accidental template-string placeholder.
const envRef = (name: string) => `\${env:${name}}`;
const secretRef = (name: string) => `\${secret:${name}}`;

test('resolveNativeCliAgentEnv resolves env refs and passes plain values through', () => {
  setEnv('NCLI_TEST_KEY', 'sk-resolved');
  const resolved = resolveNativeCliAgentEnv({ API_KEY: envRef('NCLI_TEST_KEY'), PLAIN: 'literal' }, undefined);
  expect(resolved).toEqual({ API_KEY: 'sk-resolved', PLAIN: 'literal' });
});

test('resolveNativeCliAgentEnv resolves secret refs from auth and drops unresolvable refs', () => {
  const auth = { namedSecrets: { MY_SECRET: 'from-keychain' } } as unknown as MonadAuth;
  const resolved = resolveNativeCliAgentEnv(
    { TOKEN: secretRef('MY_SECRET'), MISSING: envRef('NCLI_DEFINITELY_UNSET') },
    auth
  );
  expect(resolved?.TOKEN).toBe('from-keychain');
  expect(resolved && 'MISSING' in resolved).toBe(false);
});

test('resolveNativeCliAgentEnv returns undefined for empty/undefined env', () => {
  expect(resolveNativeCliAgentEnv(undefined, undefined)).toBeUndefined();
});
