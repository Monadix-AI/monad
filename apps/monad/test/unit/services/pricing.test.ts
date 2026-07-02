import type { ProviderCredential, ResolvedProviderConfig } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { openAiPrice, vercelGatewayPrice } from '@monad/protocol';

import { fetchProviderModels } from '@/agent/model/gateway.ts';
import { ModelProviderRegistry } from '@/agent/model/provider.ts';

test('openAiPrice normalizes $/token to $/1M and drops non-positive / missing values', () => {
  expect(
    openAiPrice({
      prompt: '0.000005',
      completion: '0.000025',
      input_cache_read: '0.0000005',
      input_cache_write: '0.00000625'
    })
  ).toEqual({
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    units: [
      { label: 'Input', unit: 'M', price: 5 },
      { label: 'Output', unit: 'M', price: 25 },
      { label: 'Cache read', unit: 'M', price: 0.5 },
      { label: 'Cache write', unit: 'M', price: 6.25 }
    ]
  });
  // A free tier ("0") must yield no price rather than a misleading $0.
  expect(openAiPrice({ prompt: '0', completion: '0' })).toBeUndefined();
  expect(openAiPrice(null)).toBeUndefined();
  expect(openAiPrice({ prompt: '0.000001' })).toEqual({
    input: 1,
    units: [{ label: 'Input', unit: 'M', price: 1 }]
  });
});

test('vercelGatewayPrice maps cache field names and normalizes', () => {
  expect(
    vercelGatewayPrice({
      input: '0.000003',
      output: '0.000015',
      cachedInputTokens: '0.0000003',
      cacheCreationInputTokens: '0.00000375'
    })
  ).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  expect(vercelGatewayPrice(null)).toBeUndefined();
});

test('fetchProviderModels attaches normalized provider-native price (OpenRouter shape)', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'anthropic/claude-opus-4.8', name: 'Opus', pricing: { prompt: '0.000005', completion: '0.000025' } },
          { id: 'free/model', name: 'Free', pricing: { prompt: '0', completion: '0' } },
          { id: 'no/price', name: 'NoPrice' }
        ]
      }),
      { status: 200 }
    )) as unknown as typeof fetch;

  const provider = { id: 'or', type: 'openrouter', baseUrl: 'https://or.test/api/v1' } as ResolvedProviderConfig;
  const cred = { accessToken: 'k' } as ProviderCredential;
  // openrouter has no custom listModels → the gateway's generic /models fallback (which attaches
  // openAiPrice) runs; an empty registry is enough to exercise it.
  const models = await fetchProviderModels(provider, cred, new ModelProviderRegistry(), fetchImpl);

  expect(models.find((m) => m.id === 'anthropic/claude-opus-4.8')?.price).toEqual({
    input: 5,
    output: 25,
    units: [
      { label: 'Input', unit: 'M', price: 5 },
      { label: 'Output', unit: 'M', price: 25 }
    ]
  });
  expect(models.find((m) => m.id === 'free/model')?.price).toBeUndefined();
  expect(models.find((m) => m.id === 'no/price')?.price).toBeUndefined();
});
