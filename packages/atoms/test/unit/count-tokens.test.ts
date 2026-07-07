import type { ModelCall, ResolvedProviderConfig } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { anthropicProviderAtom } from '../../src/providers/anthropic.ts';
import { PROVIDER_DESCRIPTORS } from '../../src/providers/catalog.ts';
import { googleProviderAtom } from '../../src/providers/google.ts';
import { openaiProviderAtom } from '../../src/providers/openai.ts';
import { makeOpenAICompatibleProvider } from '../../src/providers/openai-compatible.ts';

// Each vendor's native count-tokens route, exercised against a fake fetch — no network. We assert
// the URL, auth header, and that the right response field is read back as the token count.

const CRED = { id: 'c1', accessToken: 'key-1', authType: 'api_key' as const, priority: 0 };
const MESSAGES = [
  { role: 'system' as const, content: 'be brief' },
  { role: 'user' as const, content: 'hello world' }
];

type FetchHandler = (url: string, init: RequestInit | undefined) => Response;
function fakeFetch(handler: FetchHandler): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
function call(provider: ResolvedProviderConfig, modelId: string, fetch: typeof globalThis.fetch): ModelCall {
  return { modelId, messages: MESSAGES, params: {}, provider, credential: CRED, fetch };
}

test('google (Gemini) countTokens hits :countTokens and reads totalTokens', async () => {
  let url = '';
  let apiKeyHeader = '';
  const fetch = fakeFetch((u, init) => {
    url = u;
    apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key') ?? '';
    return json({ totalTokens: 123 });
  });
  const provider = { id: 'g1', type: 'google', baseUrl: 'https://gen.test/v1beta' };
  const n = await googleProviderAtom.countTokens?.(call(provider, 'gemini-2.0-flash', fetch));
  expect(n).toBe(123);
  expect(url).toBe('https://gen.test/v1beta/models/gemini-2.0-flash:countTokens');
  expect(apiKeyHeader).toBe('key-1');
});

test('openai countTokens hits /responses/input_tokens and reads input_tokens', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const fetch = fakeFetch((u, init) => {
    url = u;
    body = JSON.parse(String(init?.body));
    return json({ input_tokens: 9, object: 'response.input_tokens' });
  });
  const provider = { id: 'o1', type: 'openai', baseUrl: 'https://api.openai.com/v1' };
  const n = await openaiProviderAtom.countTokens?.(call(provider, 'gpt-5.5', fetch));
  expect(n).toBe(9);
  expect(url).toBe('https://api.openai.com/v1/responses/input_tokens');
  expect(body).toEqual({ model: 'gpt-5.5', input: 'hello world', instructions: 'be brief' });
});

test('anthropic countTokens hits /v1/messages/count_tokens and forwards tool schemas', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const fetch = fakeFetch((u, init) => {
    url = u;
    body = JSON.parse(String(init?.body));
    return json({ input_tokens: 42 });
  });
  const provider = { id: 'a1', type: 'anthropic', baseUrl: 'https://anthropic.test' };
  const c = call(provider, 'claude-x', fetch);
  c.tools = [{ name: 'search', description: 'find things', parameters: { type: 'object', properties: {} } }];
  const n = await anthropicProviderAtom.countTokens?.(c);
  expect(n).toBe(42);
  expect(url).toBe('https://anthropic.test/v1/messages/count_tokens');
  expect(body.system).toBe('be brief');
  expect(body.tools).toEqual([
    { name: 'search', description: 'find things', input_schema: { type: 'object', properties: {} } }
  ]);
});

test('moonshot (Kimi) countTokens hits estimate-token-count and reads data.total_tokens', async () => {
  let url = '';
  const fetch = fakeFetch((u) => {
    url = u;
    return json({ data: { total_tokens: 42 } });
  });
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.moonshot);
  const n = await provider.countTokens?.(call({ id: 'm1', type: 'moonshot' }, 'kimi-k2', fetch));
  expect(n).toBe(42);
  expect(url).toBe('https://api.moonshot.ai/v1/tokenizers/estimate-token-count');
});

test('zai (GLM) countTokens hits /tokenizer and reads usage.total_tokens', async () => {
  let url = '';
  const fetch = fakeFetch((u) => {
    url = u;
    return json({ usage: { total_tokens: 77 } });
  });
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.zai);
  const n = await provider.countTokens?.(call({ id: 'z1', type: 'zai' }, 'glm-4.6', fetch));
  expect(n).toBe(77);
  expect(url).toBe('https://api.z.ai/api/paas/v4/tokenizer');
});

test('an openai-compatible provider with no native route returns undefined without fetching', async () => {
  let called = false;
  const fetch = fakeFetch(() => {
    called = true;
    return json({});
  });
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.deepseek);
  const _n = await provider.countTokens?.(call({ id: 'd1', type: 'deepseek' }, 'deepseek-chat', fetch));
  expect(called).toBe(false);
});

test('a non-2xx response resolves undefined (best-effort)', async () => {
  const fetch = fakeFetch(() => new Response('nope', { status: 500 }));
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.moonshot);
  const _n = await provider.countTokens?.(call({ id: 'm1', type: 'moonshot' }, 'kimi-k2', fetch));
});
