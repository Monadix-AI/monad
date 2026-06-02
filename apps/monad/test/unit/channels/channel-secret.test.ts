import type { MonadAuth } from '@monad/home';

import { expect, test } from 'bun:test';

import { resolveChannelSecretRef } from '@/config/secrets.ts';

function auth(over: Partial<MonadAuth> = {}): MonadAuth {
  return { version: 1, activeProvider: null, updatedAt: '', credentialPool: {}, ...over };
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
test('resolves ${env:NAME} from the environment', () => {
  Bun.env.TEST_CHANNEL_TOKEN = 'env-token';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(resolveChannelSecretRef('${env:TEST_CHANNEL_TOKEN}', auth())).toBe('env-token');
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only env var set/deleted in same block
  delete Bun.env.TEST_CHANNEL_TOKEN;
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
test('throws on an unset ${env:NAME}', () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only env var deleted to ensure unset
  delete Bun.env.NOPE_TOKEN;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(() => resolveChannelSecretRef('${env:NOPE_TOKEN}', auth())).toThrow();
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
test('resolves ${secret:channel/<id>/token} from auth.json', () => {
  const a = auth({ channelCredentials: { chn_A: { token: 'stored-token' } } });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(resolveChannelSecretRef('${secret:channel/chn_A/token}', a)).toBe('stored-token');
});

test('throws when the auth.json channel credential is missing', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(() => resolveChannelSecretRef('${secret:channel/chn_A/token}', auth())).toThrow();
});

test('passes a plain literal through unchanged', () => {
  expect(resolveChannelSecretRef('literal-token', auth())).toBe('literal-token');
});
