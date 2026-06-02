import { expect, test } from 'bun:test';

import { addProviderInteractive, chooseDefaultModelInteractive } from '../../src/lib/init-flow.ts';

function ok<T>(data: T) {
  return { data, status: 200 };
}

async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}

test('init provider setup retries after a failed connection test instead of exiting', async () => {
  const answers = ['1', 'bad-key', '1', 'good-key'];
  const testTokens: string[] = [];
  const savedProviders: unknown[] = [];
  const savedCredentials: unknown[] = [];
  const providers = Object.assign(
    ({ id }: { id: string }) => ({
      put: async (body: unknown) => {
        savedProviders.push({ id, body });
        return ok({});
      },
      credentials: {
        post: async (body: unknown) => {
          savedCredentials.push({ id, body });
          return ok({});
        }
      }
    }),
    {
      catalog: {
        get: async () =>
          ok({
            providers: [
              {
                label: 'OpenAI',
                type: 'openai',
                needsUrl: false,
                keyOptional: false
              }
            ]
          })
      }
    }
  );
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers,
            'test-connection': {
              post: async ({ accessToken }: { accessToken: string }) => {
                testTokens.push(accessToken);
                return ok(accessToken === 'good-key' ? { ok: true } : { ok: false, error: 'invalid key' });
              }
            }
          }
        }
      }
    }
  };

  const result = await silently(() =>
    addProviderInteractive(client as never, {
      ask: async () => answers.shift() ?? ''
    })
  );

  expect(result?.label).toBe('OpenAI');
  expect(testTokens).toEqual(['bad-key', 'good-key']);
  expect(savedProviders).toHaveLength(1);
  expect(savedCredentials).toHaveLength(1);
});

test('init provider setup can go back to provider selection after a failed connection test', async () => {
  const answers = ['1', 'bad-key', '2', '2', 'good-key'];
  const selectedTypes: string[] = [];
  const providers = Object.assign(
    (_args: { id: string }) => ({
      put: async ({ provider }: { provider: { type: string } }) => {
        selectedTypes.push(provider.type);
        return ok({});
      },
      credentials: {
        post: async () => ok({})
      }
    }),
    {
      catalog: {
        get: async () =>
          ok({
            providers: [
              { label: 'OpenAI', type: 'openai', needsUrl: false, keyOptional: false },
              { label: 'Anthropic', type: 'anthropic', needsUrl: false, keyOptional: false }
            ]
          })
      }
    }
  );
  const client = {
    treaty: {
      v1: {
        settings: {
          model: {
            providers,
            'test-connection': {
              post: async ({ accessToken }: { accessToken: string }) =>
                ok(accessToken === 'good-key' ? { ok: true } : { ok: false, error: 'invalid key' })
            }
          }
        }
      }
    }
  };

  const result = await silently(() =>
    addProviderInteractive(client as never, {
      ask: async () => answers.shift() ?? ''
    })
  );

  expect(result?.label).toBe('Anthropic');
  expect(selectedTypes).toEqual(['anthropic']);
});

test('init default model setup accepts a listed model by number', async () => {
  const result = await silently(() =>
    chooseDefaultModelInteractive(
      [
        { id: 'model-a', label: 'Model A' },
        { id: 'model-b', label: 'Model B' }
      ],
      { ask: async () => '2' }
    )
  );

  expect(result).toBe('model-b');
});

test('init default model setup preserves custom model ids', async () => {
  const result = await silently(() =>
    chooseDefaultModelInteractive([{ id: 'model-a', label: 'Model A' }], {
      ask: async () => 'custom/model'
    })
  );

  expect(result).toBe('custom/model');
});

test('init default model setup reprompts when a provider has no models', async () => {
  const answers = ['', 'manual/model'];
  const result = await silently(() =>
    chooseDefaultModelInteractive([], {
      ask: async () => answers.shift() ?? ''
    })
  );

  expect(result).toBe('manual/model');
});
