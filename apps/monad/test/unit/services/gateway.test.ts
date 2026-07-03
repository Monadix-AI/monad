import { expect, test } from 'bun:test';

import { type GatewayDeps, GatewayModelRouter, ModelProviderRegistry } from '@/agent/index.ts';
import { builtinModelProviders } from '../../../../../packages/atoms/src/providers/index.ts';

// The gateway is driven through the REAL first-party providers (from @monad/atoms) registered
// here; each provider's ai-sdk client speaks to the injected fake fetch — no network.
const registry = new ModelProviderRegistry();
for (const p of builtinModelProviders) registry.register(p);
const mkRouter = (d: GatewayDeps) => new GatewayModelRouter(d, registry);

// Offline tests: every provider is `openai-compatible`, so the real AI SDK provider
// speaks the OpenAI chat-completions wire format to an injected fake fetch — no network.
// The fake fetch reads the Bearer token to tell credentials apart and to simulate
// per-credential failures.

function jsonResponse(text: string): Response {
  const body = {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(deltas: string[]): Response {
  const frames = deltas.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('');
  return new Response(`${frames}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}

function err429(): Response {
  return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
}

function tokenOf(init: RequestInit | undefined): string {
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  return auth.replace(/^Bearer\s+/i, '');
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
function fakeFetch(handler: FetchHandler): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}

const PROVIDER = { id: 'u1', type: 'openai-compatible' as const, baseUrl: 'https://example.test/v1' };

function deps(over: Partial<GatewayDeps>): GatewayDeps {
  return {
    providers: [PROVIDER],
    profiles: [{ alias: 'default', routes: { chat: { provider: 'u1', modelId: 'm1' } }, params: {}, fallbacks: [] }],
    defaultProfile: 'default',
    credentialsFor: () => [{ id: 'c1', accessToken: 'key-1', authType: 'api_key', priority: 0 }],
    ...over
  };
}

const userMsg = [{ role: 'user' as const, content: 'hi' }];

test('complete() resolves the default profile and returns text', async () => {
  const router = mkRouter(deps({ fetch: fakeFetch(() => jsonResponse('hello')) }));
  const result = await router.complete({ model: '', messages: userMsg });
  expect(result.text).toBe('hello');
  expect(result.usage?.totalTokens).toBe(2);
});

test('stream() yields one chunk per token delta', async () => {
  const router = mkRouter(deps({ fetch: fakeFetch(() => sseResponse(['Hel', 'lo'])) }));
  const tokens: string[] = [];
  for await (const chunk of router.stream({ model: 'default', messages: userMsg }))
    if (chunk.type === 'text') tokens.push(chunk.token);
  expect(tokens.join('')).toBe('Hello');
});

test('falls over to the next credential on 429', async () => {
  const reported: Array<[string, boolean]> = [];
  const router = mkRouter(
    deps({
      credentialsFor: () => [
        { id: 'c1', accessToken: 'bad', authType: 'api_key', priority: 0 },
        { id: 'c2', accessToken: 'good', authType: 'api_key', priority: 1 }
      ],
      reportCredential: (_u, id, ok) => reported.push([id, ok]),
      fetch: fakeFetch((_url, init) => (tokenOf(init) === 'good' ? jsonResponse('ok') : err429()))
    })
  );
  const result = await router.complete({ model: 'default', messages: userMsg });
  expect(result.text).toBe('ok');
  expect(reported).toEqual([
    ['c1', false],
    ['c2', true]
  ]);
});

test('falls over to a raw fallback target when the primary provider has no credentials', async () => {
  const router = mkRouter(
    deps({
      providers: [
        { id: 'dead', type: 'openai-compatible', baseUrl: 'https://dead.test/v1' },
        { id: 'live', type: 'openai-compatible', baseUrl: 'https://live.test/v1' }
      ],
      profiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'dead', modelId: 'm1' } },
          params: {},
          fallbacks: [{ provider: 'live', modelId: 'm2' }]
        }
      ],
      credentialsFor: (u) => (u === 'live' ? [{ id: 'c2', accessToken: 'k', authType: 'api_key', priority: 0 }] : []),
      fetch: fakeFetch((url) => (url.includes('live.test') ? jsonResponse('from-live') : err429()))
    })
  );
  const result = await router.complete({ model: 'default', messages: userMsg });
  expect(result.text).toBe('from-live');
});

test('raw "providerId:modelId" spec bypasses profiles', async () => {
  let seenModel = '';
  const router = mkRouter(
    deps({
      fetch: fakeFetch(async (_url, init) => {
        seenModel = JSON.parse(String(init?.body)).model;
        return jsonResponse('raw');
      })
    })
  );
  const result = await router.complete({ model: 'u1:custom-model', messages: userMsg });
  expect(result.text).toBe('raw');
  expect(seenModel).toBe('custom-model');
});

test('maps generation params onto the request body', async () => {
  let body: Record<string, unknown> = {};
  const router = mkRouter(
    deps({
      profiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'u1', modelId: 'm1' } },
          params: { temperature: 0.5, topP: 0.9 },
          fallbacks: []
        }
      ],
      fetch: fakeFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse('ok');
      })
    })
  );
  await router.complete({ model: 'default', messages: userMsg });
  expect(body.temperature).toBe(0.5);
  expect(body.top_p).toBe(0.9);
});

test('per-request params override the profile', async () => {
  let body: Record<string, unknown> = {};
  const router = mkRouter(
    deps({
      profiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'u1', modelId: 'm1' } },
          params: { temperature: 0.2 },
          fallbacks: []
        }
      ],
      fetch: fakeFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse('ok');
      })
    })
  );
  await router.complete({ model: 'default', messages: userMsg, params: { temperature: 1.1 } });
  expect(body.temperature).toBe(1.1);
});

test('raw specs that match profile role routes use that role params', async () => {
  let body: Record<string, unknown> = {};
  const router = mkRouter(
    deps({
      profiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'u1', modelId: 'm1' }, fast: { provider: 'u1', modelId: 'm-fast' } },
          params: {},
          routeParams: { fast: { temperature: 0.7 } },
          fallbacks: []
        }
      ],
      fetch: fakeFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse('ok');
      })
    })
  );
  await router.complete({ model: 'u1:m-fast', messages: userMsg });
  expect(body.model).toBe('m-fast');
  expect(body.temperature).toBe(0.7);
});

test('guards against profile fallback cycles (terminates, throws when all fail)', async () => {
  const router = mkRouter(
    deps({
      profiles: [
        { alias: 'a', routes: { chat: { provider: 'u1', modelId: 'ma' } }, params: {}, fallbacks: [{ profile: 'b' }] },
        { alias: 'b', routes: { chat: { provider: 'u1', modelId: 'mb' } }, params: {}, fallbacks: [{ profile: 'a' }] }
      ],
      defaultProfile: 'a',
      fetch: fakeFetch(() => err429())
    })
  );
  // If the cycle guard were broken this would hang; it should reject promptly.
  await expect(router.complete({ model: 'a', messages: userMsg })).rejects.toThrow();
});

test('throws on an unknown primary profile', async () => {
  const router = mkRouter(deps({ fetch: fakeFetch(() => jsonResponse('x')) }));
  await expect(router.complete({ model: 'nope', messages: userMsg })).rejects.toThrow(/unknown model profile/);
});

test('complete() stamps the resolved provider/modelId on usage', async () => {
  const router = mkRouter(deps({ fetch: fakeFetch(() => jsonResponse('ok')) }));
  const result = await router.complete({ model: 'u1:custom-model', messages: userMsg });
  expect(result.usage?.provider).toBe('u1');
  expect(result.usage?.modelId).toBe('custom-model');
});

test('usage is attributed to the FALLBACK model that actually served the turn', async () => {
  const router = mkRouter(
    deps({
      providers: [
        { id: 'dead', type: 'openai-compatible', baseUrl: 'https://dead.test/v1' },
        { id: 'live', type: 'openai-compatible', baseUrl: 'https://live.test/v1' }
      ],
      profiles: [
        {
          alias: 'default',
          routes: { chat: { provider: 'dead', modelId: 'm1' } },
          params: {},
          fallbacks: [{ provider: 'live', modelId: 'm2' }]
        }
      ],
      credentialsFor: (u) => (u === 'live' ? [{ id: 'c2', accessToken: 'k', authType: 'api_key', priority: 0 }] : []),
      fetch: fakeFetch((url) => (url.includes('live.test') ? jsonResponse('from-live') : err429()))
    })
  );
  const result = await router.complete({ model: 'default', messages: userMsg });
  expect(result.text).toBe('from-live');
  // The default profile is "dead/m1", but "live/m2" served it — cost must follow the real model.
  expect(result.usage?.provider).toBe('live');
  expect(result.usage?.modelId).toBe('m2');
});

test('countTokens delegates to a provider with a native endpoint', async () => {
  let seenUrl = '';
  let seenBody: Record<string, unknown> = {};
  const router = mkRouter(
    deps({
      providers: [{ id: 'a1', type: 'anthropic', baseUrl: 'https://anthropic.test' }],
      profiles: [
        { alias: 'default', routes: { chat: { provider: 'a1', modelId: 'claude-x' } }, params: {}, fallbacks: [] }
      ],
      fetch: fakeFetch((url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ input_tokens: 42 }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    })
  );
  const count = await router.countTokens({
    model: 'default',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi there' }
    ]
  });
  expect(count).toBe(42);
  expect(seenUrl).toContain('/v1/messages/count_tokens');
  expect(seenBody.model).toBe('claude-x');
  expect(seenBody.system).toBe('be brief');
});

test('countTokens forwards tool schemas so the count includes them', async () => {
  let seenBody: Record<string, unknown> = {};
  const router = mkRouter(
    deps({
      providers: [{ id: 'a1', type: 'anthropic', baseUrl: 'https://anthropic.test' }],
      profiles: [
        { alias: 'default', routes: { chat: { provider: 'a1', modelId: 'claude-x' } }, params: {}, fallbacks: [] }
      ],
      fetch: fakeFetch((_url, init) => {
        seenBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ input_tokens: 7 }), { headers: { 'Content-Type': 'application/json' } });
      })
    })
  );
  await router.countTokens({
    model: 'default',
    messages: userMsg,
    tools: [{ name: 'search', description: 'find things', parameters: { type: 'object', properties: {} } }]
  });
  expect(seenBody.tools).toEqual([
    { name: 'search', description: 'find things', input_schema: { type: 'object', properties: {} } }
  ]);
});

test('countTokens returns undefined for a provider without a native endpoint', async () => {
  // openai-compatible has no countTokens provider method ⇒ caller falls back to the char heuristic.
  const router = mkRouter(deps({ fetch: fakeFetch(() => jsonResponse('x')) }));
  expect(await router.countTokens({ model: 'default', messages: userMsg })).toBeUndefined();
});

test('countTokens swallows a provider error and resolves undefined', async () => {
  const router = mkRouter(
    deps({
      providers: [{ id: 'a1', type: 'anthropic', baseUrl: 'https://anthropic.test' }],
      profiles: [
        { alias: 'default', routes: { chat: { provider: 'a1', modelId: 'claude-x' } }, params: {}, fallbacks: [] }
      ],
      fetch: fakeFetch(() => new Response('nope', { status: 500 }))
    })
  );
  expect(await router.countTokens({ model: 'default', messages: userMsg })).toBeUndefined();
});

test('stream falls over before the first token', async () => {
  const router = mkRouter(
    deps({
      credentialsFor: () => [
        { id: 'c1', accessToken: 'bad', authType: 'api_key', priority: 0 },
        { id: 'c2', accessToken: 'good', authType: 'api_key', priority: 1 }
      ],
      fetch: fakeFetch((_url, init) => (tokenOf(init) === 'good' ? sseResponse(['hi']) : err429()))
    })
  );
  const tokens: string[] = [];
  for await (const chunk of router.stream({ model: 'default', messages: userMsg }))
    if (chunk.type === 'text') tokens.push(chunk.token);
  expect(tokens.join('')).toBe('hi');
});

function embeddingsResponse(vectors: number[][]): Response {
  const body = {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model: 'm-embed',
    usage: { prompt_tokens: 1, total_tokens: 1 }
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

test('embed() throws when no embedding model is configured', async () => {
  const router = mkRouter(deps({ fetch: fakeFetch(() => embeddingsResponse([[1, 2]])) }));
  expect(router.embed(['hi'])).rejects.toThrow(/no embedding model configured/);
});

test('embed() returns [] for an empty batch without calling the provider', async () => {
  let called = false;
  const router = mkRouter(
    deps({
      embeddingModel: 'u1:text-embedding-3-small',
      fetch: fakeFetch(() => {
        called = true;
        return embeddingsResponse([]);
      })
    })
  );
  expect(await router.embed([])).toEqual({ embeddings: [] });
  expect(called).toBe(false);
});

test('embed() routes to the configured embedding model and returns one vector per input', async () => {
  const router = mkRouter(
    deps({
      embeddingModel: 'u1:text-embedding-3-small',
      fetch: fakeFetch((url) => {
        expect(url).toContain('/embeddings');
        return embeddingsResponse([
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6]
        ]);
      })
    })
  );
  const { embeddings, usage } = await router.embed(['a', 'b']);
  expect(embeddings).toEqual([
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6]
  ]);
  // usage is reported and stamped with the resolved provider/model (for ledger booking).
  expect(usage?.provider).toBe('u1');
  expect(usage?.modelId).toBe('text-embedding-3-small');
});

test('embed() falls over to the next credential on 429', async () => {
  const reported: Array<[string, boolean]> = [];
  const router = mkRouter(
    deps({
      embeddingModel: 'u1:text-embedding-3-small',
      credentialsFor: () => [
        { id: 'c1', accessToken: 'bad', authType: 'api_key', priority: 0 },
        { id: 'c2', accessToken: 'good', authType: 'api_key', priority: 1 }
      ],
      reportCredential: (_u, id, ok) => reported.push([id, ok]),
      fetch: fakeFetch((_url, init) => (tokenOf(init) === 'good' ? embeddingsResponse([[9, 9]]) : err429()))
    })
  );
  expect((await router.embed(['x'])).embeddings).toEqual([[9, 9]]);
  expect(reported).toEqual([
    ['c1', false],
    ['c2', true]
  ]);
});
