import type { MonadAuth } from '../../src/config/index.ts';

import { expect, test } from 'bun:test';

import { resolvePeerSecretRef } from '../../src/config/index.ts';

function auth(over: Partial<MonadAuth> = {}): MonadAuth {
  return { version: 1, activeProvider: null, updatedAt: '', credentialPool: {}, ...over };
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
test('resolves ${env:NAME} from the environment', () => {
  Bun.env.TEST_PEER_TOKEN = 'env-token';
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(resolvePeerSecretRef('${env:TEST_PEER_TOKEN}', auth())).toBe('env-token');
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only env var set/deleted in same block
  delete Bun.env.TEST_PEER_TOKEN;
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
test('throws on an unset ${env:NAME}', () => {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only env var deleted to ensure unset
  delete Bun.env.NOPE_PEER_TOKEN;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(() => resolvePeerSecretRef('${env:NOPE_PEER_TOKEN}', auth())).toThrow();
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
test('resolves ${secret:peer/<id>/token} from auth.json', () => {
  const a = auth({ peerCredentials: { peer_A: { token: 'stored-token' } } });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(resolvePeerSecretRef('${secret:peer/peer_A/token}', a)).toBe('stored-token');
});

test('throws when the auth.json peer credential is missing', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(() => resolvePeerSecretRef('${secret:peer/peer_A/token}', auth())).toThrow();
});

// The channel scheme must NOT resolve via the peer resolver (distinct namespaces) — it passes
// through as a literal rather than reading channelCredentials.
test('does not resolve a channel-scheme ref (wrong namespace passes through)', () => {
  const a = auth({ channelCredentials: { chn_A: { token: 'channel-token' } } });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
  expect(resolvePeerSecretRef('${secret:channel/chn_A/token}', a)).toBe('${secret:channel/chn_A/token}');
});

test('passes a plain literal through unchanged', () => {
  expect(resolvePeerSecretRef('literal-token', auth())).toBe('literal-token');
});
