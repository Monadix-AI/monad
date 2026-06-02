import { expect, test } from 'bun:test';

import { maskSecret, redactSecrets } from '../../src/lib/redact.ts';

test('a secret keeps only enough tail to identify which credential it is', () => {
  expect(maskSecret('fixture-openrouter-credential-dae6')).toBe('••••dae6');
  expect(maskSecret('short')).toBe('••••');
  expect(maskSecret('')).toBe('');
});

test('secrets nested inside arrays and objects are masked in place', () => {
  // The shape `monad config list` actually leaked: provider credentials arrive as an array of
  // objects, which the flattener then prints as one JSON string.
  const config = {
    openaiCompat: { token: 'fixture-openai-credential-1fa1' },
    model: {
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          credentials: [{ id: 'cred_1', label: 'seed', accessToken: 'fixture-openrouter-credential-6789' }]
        }
      ]
    }
  };

  expect(redactSecrets(config)).toEqual({
    openaiCompat: { token: '••••1fa1' },
    model: {
      providers: [
        {
          id: 'openrouter',
          label: 'OpenRouter',
          credentials: [{ id: 'cred_1', label: 'seed', accessToken: '••••6789' }]
        }
      ]
    }
  });
});

test('non-secret configuration survives untouched', () => {
  const config = {
    network: { port: 47749, transport: 'uds', remoteAccess: { enabled: false, token: null } },
    context: { eviction: { minResultTokens: 200 } },
    agent: { maxThinkingTokens: 4096, credentialIds: ['cred_1'] }
  };
  // `maxThinkingTokens` and `credentialIds` read as secret-ish by name but hold no secret; masking
  // them would hide real configuration. A null token has nothing to mask.
  expect(redactSecrets(config)).toEqual(config);
});

test('a bare value fetched by a secret-named path is masked too', () => {
  // `monad config get openaiCompat.token` hands the masker a plain string, not an object.
  expect(redactSecrets('sk-1fc680c815102147fab0bc92', 'token')).toBe('••••bc92');
  expect(redactSecrets('uds', 'transport')).toBe('uds');
});
