import type { ModelCall, ModelChunk, ResolvedProviderConfig } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { KNOWN_PROVIDER_TYPES } from '@monad/protocol';

import { PROVIDER_DESCRIPTORS } from '../../src/providers/catalog.ts';
import { builtinModelProviders, makeOpenAICompatibleProvider, splitSystem } from '../../src/providers/index.ts';

const CRED = { id: 'c1', accessToken: 'key-1', authType: 'api_key' as const, priority: 0 };
const userMsg = [{ role: 'user' as const, content: 'hi' }];

type FetchHandler = (url: string, init: RequestInit | undefined) => Response;
function fakeFetch(handler: FetchHandler): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}
function sseResponse(deltas: string[]): Response {
  const frames = deltas.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('');
  return new Response(`${frames}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
function jsonResponse(text: string): Response {
  const body = {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
function call(provider: ResolvedProviderConfig, modelId: string, fetch: typeof globalThis.fetch): ModelCall {
  return { modelId, messages: userMsg, params: {}, provider, credential: CRED, fetch };
}

// ── registry coverage ────────────────────────────────────────────────────────

test('builtin providers cover exactly the known provider types', () => {
  const types = new Set(builtinModelProviders.map((p) => p.type));
  expect(types).toEqual(new Set(KNOWN_PROVIDER_TYPES));
});

test('every builtin provider carries a descriptor and a stream()', () => {
  for (const p of builtinModelProviders) {
    expect(p.descriptor.type).toBe(p.type);
    expect(typeof p.stream).toBe('function');
  }
});

test('image/speech are wired only on providers that build those models (openai), not text-only ones', () => {
  const byType = new Map(builtinModelProviders.map((p) => [p.type, p]));
  // openai supplies buildImageModel/buildSpeechModel → defineAiSdkProvider exposes the methods.
  expect(typeof byType.get('openai')?.generateImage).toBe('function');
  expect(typeof byType.get('openai')?.generateSpeech).toBe('function');
  // text-only providers must NOT advertise them (so the gateway fails over instead of throwing).
  expect(byType.get('anthropic')?.generateImage).toBeUndefined();
  expect(byType.get('mistral')?.generateSpeech).toBeUndefined();
  expect(byType.get('groq')?.generateImage).toBeUndefined();
});

test('OpenRouter listModels rejects invalid credentials even when public models are readable', async () => {
  const openrouter = builtinModelProviders.find((p) => p.type === 'openrouter');
  if (!openrouter?.listModels) throw new Error('openrouter provider missing');

  const fetch = fakeFetch((u) => {
    if (u.endsWith('/api/v1/auth/key')) return new Response('invalid key', { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-test', name: 'GPT Test' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  });

  await expect(openrouter.listModels({ id: 'openrouter', type: 'openrouter' }, CRED, fetch)).rejects.toThrow(
    /OpenRouter auth failed: 401/
  );
});

test('Anthropic listModels loads every paged result', async () => {
  const anthropic = builtinModelProviders.find((p) => p.type === 'anthropic');
  if (!anthropic?.listModels) throw new Error('anthropic provider missing');
  const seen: string[] = [];
  const fetch = fakeFetch((u) => {
    seen.push(u);
    const url = new URL(u);
    if (url.searchParams.get('after_id') === 'm1') {
      return new Response(
        JSON.stringify({ data: [{ id: 'm2', display_name: 'Model 2' }], has_more: false, last_id: 'm2' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ data: [{ id: 'm1', display_name: 'Model 1' }], has_more: true, last_id: 'm1' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const models = await anthropic.listModels({ id: 'anthropic', type: 'anthropic' }, CRED, fetch);

  expect(models.map((m) => m.id)).toEqual(['m1', 'm2']);
  expect(seen.map((u) => new URL(u).searchParams.get('after_id'))).toEqual([null, 'm1']);
});

test('Google listModels loads every paged result', async () => {
  const google = builtinModelProviders.find((p) => p.type === 'google');
  if (!google?.listModels) throw new Error('google provider missing');
  const seen: string[] = [];
  const fetch = fakeFetch((u) => {
    seen.push(u);
    const url = new URL(u);
    if (url.searchParams.get('pageToken') === 'next') {
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2', displayName: 'Gemini 2' }] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(
      JSON.stringify({
        models: [{ name: 'models/gemini-1', displayName: 'Gemini 1' }],
        nextPageToken: 'next'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  });

  const models = await google.listModels({ id: 'google', type: 'google' }, CRED, fetch);

  expect(models.map((m) => m.id)).toEqual(['gemini-1', 'gemini-2']);
  expect(seen.map((u) => new URL(u).searchParams.get('pageToken'))).toEqual([null, 'next']);
});

// ── openai-compatible preset base URL ────────────────────────────────────────

test('an openai-compatible preset targets the catalog default base URL', async () => {
  let seen = '';
  const fetch = fakeFetch((u) => {
    seen = u;
    return sseResponse(['hi']);
  });
  const groq = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.groq);
  // No baseUrl on provider/credential — must fall back to the descriptor preset.
  for await (const _ of groq.stream(call({ id: 'groq', type: 'groq' }, 'llama-3.3-70b', fetch))) {
    /* drain */
  }
  const base = PROVIDER_DESCRIPTORS.groq.defaultBaseUrl ?? '';
  expect(base).toContain('api.groq.com');
  expect(seen.startsWith(base)).toBe(true);
});

test('Amazon Bedrock requires a region (extra.region)', async () => {
  const bedrock = builtinModelProviders.find((p) => p.type === 'amazon-bedrock');
  if (!bedrock) throw new Error('bedrock provider missing');
  const run = async () => {
    for await (const _ of bedrock.stream(call({ id: 'bedrock', type: 'amazon-bedrock' }, 'claude', globalThis.fetch))) {
      /* drain */
    }
  };
  await expect(run()).rejects.toThrow(/region/i);
});

// ── stream / complete via the real adapter (fake fetch, no network) ───────────

test('stream() yields one chunk per token delta', async () => {
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.groq);
  const fetch = fakeFetch(() => sseResponse(['Hel', 'lo']));
  const tokens: string[] = [];
  for await (const chunk of provider.stream(call({ id: 'g', type: 'groq' }, 'm', fetch)) as AsyncIterable<ModelChunk>) {
    if (chunk.type === 'text') tokens.push(chunk.token);
  }
  expect(tokens.join('')).toBe('Hello');
});

test('complete() returns the full text and surfaces provider usage', async () => {
  const provider = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS.groq);
  const fetch = fakeFetch(() => jsonResponse('Hello world'));
  const result = await provider.complete?.(call({ id: 'g', type: 'groq' }, 'm', fetch));
  expect(result?.text).toBe('Hello world');
  expect(result?.usage?.inputTokens).toBe(3);
});

// ── splitSystem (model-layer bridge) ─────────────────────────────────────────

test('splitSystem extracts the system to the param by default', () => {
  const { system, messages } = splitSystem([
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' }
  ]);
  expect(system).toBe('you are helpful');
  expect(messages.every((m) => m.role !== 'system')).toBe(true);
});

test('splitSystem with cache emits a leading system message carrying an Anthropic cache breakpoint', () => {
  const { system, messages } = splitSystem([
    { role: 'system', content: 'static prefix', cache: true },
    { role: 'user', content: 'hi' }
  ]);
  expect(system).toBeUndefined();
  const first = messages[0] as { role: string; providerOptions?: Record<string, unknown> };
  expect(first.role).toBe('system');
  expect(first.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
});

test('splitSystem maps multimodal image parts and passes strings through', () => {
  const { system, messages } = splitSystem([
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', image: 'data:x', mediaType: 'image/png' }
      ]
    }
  ]);
  expect(system).toBe('sys');
  expect((messages[0] as { content: unknown }).content).toEqual([
    { type: 'text', text: 'hi' },
    { type: 'image', image: 'data:x', mediaType: 'image/png' }
  ]);
});
