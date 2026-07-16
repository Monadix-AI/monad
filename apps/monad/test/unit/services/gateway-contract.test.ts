import type { ModelCall, ModelChunk, ModelProvider } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { type GatewayDeps, GatewayModelRouter, ModelProviderRegistry } from '#/agent/index.ts';

// These exercise the gateway against the ai-sdk-FREE ModelProvider contract directly (no ai-sdk,
// no fetch): the `complete()` aggregation fallback for providers that only implement `stream`, and
// the resolved-provider/model stamping on usage. The ai-sdk-backed path is covered in gateway.test.

function registryWith(provider: ModelProvider): ModelProviderRegistry {
  const reg = new ModelProviderRegistry();
  reg.register(provider);
  return reg;
}

function deps(): GatewayDeps {
  return {
    providers: [{ id: 'mock', type: 'mock' }],
    profiles: [
      { alias: 'default', routes: { chat: { provider: 'mock', modelId: 'mock-model' } }, params: {}, fallbacks: [] }
    ],
    defaultProfile: 'default',
    credentialsFor: () => [{ id: 'c1', accessToken: 'k', authType: 'api_key', priority: 0 }]
  };
}

const userMsg = [{ role: 'user' as const, content: 'hi' }];

// A provider that implements ONLY stream() — forces the gateway's complete() to aggregate.
const streamOnly: ModelProvider = {
  type: 'mock',
  descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
  async *stream(): AsyncIterable<ModelChunk> {
    yield { type: 'text', token: 'Hel' };
    yield { type: 'text', token: 'lo' };
    yield { type: 'tool-call', call: { toolCallId: 't1', toolName: 'search', input: { q: 'x' } } };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
  }
};

test('complete() aggregates a stream-only provider into text + toolCalls + usage + finishReason', async () => {
  const router = new GatewayModelRouter(deps(), registryWith(streamOnly));
  const result = await router.complete({ model: 'default', messages: userMsg });
  expect(result.text).toBe('Hello');
  expect(result.toolCalls).toEqual([{ toolCallId: 't1', toolName: 'search', input: { q: 'x' } }]);
  expect(result.finishReason).toBe('tool-calls'); // tool-calls present ⇒ loop continues
  expect(result.usage?.totalTokens).toBe(5);
});

test('complete() stamps the resolved provider+model onto the aggregated usage', async () => {
  const router = new GatewayModelRouter(deps(), registryWith(streamOnly));
  const result = await router.complete({ model: 'mock:mock-model', messages: userMsg });
  expect(result.usage?.provider).toBe('mock');
  expect(result.usage?.modelId).toBe('mock-model');
});

test('stream() stamps the resolved provider+model onto the usage chunk', async () => {
  const router = new GatewayModelRouter(deps(), registryWith(streamOnly));
  let usage: { provider?: string; modelId?: string } | undefined;
  for await (const chunk of router.stream({ model: 'mock:mock-model', messages: userMsg })) {
    if (chunk.type === 'usage') usage = chunk.usage;
  }
  expect(usage?.provider).toBe('mock');
  expect(usage?.modelId).toBe('mock-model');
});

test('stream() forwards the request abort signal to the provider', async () => {
  let receivedSignal: AbortSignal | undefined;
  const provider: ModelProvider = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async *stream(call): AsyncIterable<ModelChunk> {
      receivedSignal = call.signal;
      yield { type: 'text', token: 'done' };
    }
  };
  const router = new GatewayModelRouter(deps(), registryWith(provider));
  const controller = new AbortController();

  for await (const _chunk of router.stream({
    model: 'default',
    messages: userMsg,
    signal: controller.signal
  })) {
    // consume the stream
  }

  expect(receivedSignal).toBe(controller.signal);
});

test('a stream-only provider with no tool-calls finishes with "stop"', async () => {
  const textOnly: ModelProvider = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: 'text', token: 'done' };
    }
  };
  const router = new GatewayModelRouter(deps(), registryWith(textOnly));
  const result = await router.complete({ model: 'default', messages: userMsg });
  expect(result.text).toBe('done');
  expect(result.finishReason).toBe('stop');
});

test('countTokens delegates to the provider and returns its count', async () => {
  const counting: ModelProvider = {
    ...streamOnly,
    async countTokens(call: ModelCall) {
      return call.messages.length === 1 ? 42 : undefined;
    }
  };
  const router = new GatewayModelRouter(deps(), registryWith(counting));
  expect(await router.countTokens({ model: 'default', messages: userMsg })).toBe(42);
});

test('countTokens returns undefined when the provider has no native counter', async () => {
  const router = new GatewayModelRouter(deps(), registryWith(streamOnly));
  expect(await router.countTokens({ model: 'default', messages: userMsg })).toBeUndefined();
});

test('generateImage routes to a provider that supports it', async () => {
  const imageProvider = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async generateImage(call) {
      return { image: new Uint8Array([call.prompt.length]), mediaType: 'image/png' };
    }
  } satisfies ModelProvider;
  const router = new GatewayModelRouter(deps(), registryWith(imageProvider));
  const result = await router.generateImage({ model: 'default', prompt: 'cat' });
  expect(result.mediaType).toBe('image/png');
  expect(Array.from(result.image)).toEqual([3]); // 'cat'.length
});

test('transcribe routes to a provider that supports audio transcription', async () => {
  const transcriptionProvider = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async transcribe(call) {
      const length = call.audio instanceof Uint8Array ? call.audio.length : 0;
      return { text: `${call.modelId}:${call.mediaType}`, usage: { inputTokens: length } };
    }
  } satisfies ModelProvider;
  const router = new GatewayModelRouter(deps(), registryWith(transcriptionProvider));
  const result = await router.transcribe({
    model: 'default',
    audio: new Uint8Array([1, 2, 3]),
    mediaType: 'audio/wav'
  });
  expect(result).toEqual({ text: 'mock-model:audio/wav', usage: { inputTokens: 3 } });
});

test('rerank routes to a provider that supports reranking', async () => {
  const rerankProvider = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async rerank(call) {
      return {
        ranking: call.documents.map((document, index) => ({
          index,
          score: index === 0 ? 0.2 : 0.8,
          document
        }))
      };
    }
  } satisfies ModelProvider;
  const router = new GatewayModelRouter(deps(), registryWith(rerankProvider));
  const result = await router.rerank({
    model: 'default',
    query: 'best',
    documents: ['a', 'b'],
    topN: 2
  });
  expect(result.ranking).toEqual([
    { index: 0, score: 0.2, document: 'a' },
    { index: 1, score: 0.8, document: 'b' }
  ]);
});

test('complete() fails clearly when the resolved provider has no text generation capability', async () => {
  const imageOnly = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async generateImage() {
      return { image: new Uint8Array([1]), mediaType: 'image/png' };
    }
  } satisfies ModelProvider;
  const router = new GatewayModelRouter(deps(), registryWith(imageOnly));
  await expect(router.complete({ model: 'default', messages: userMsg })).rejects.toThrow(/text generation/i);
});

test('generateImage throws when no provider in the chain supports image generation', async () => {
  const router = new GatewayModelRouter(deps(), registryWith(streamOnly)); // stream-only, no generateImage
  await expect(router.generateImage({ model: 'default', prompt: 'cat' })).rejects.toThrow(/image generation/i);
});

test('finish chunk in a stream is surfaced as the result finishReason (aggregation path)', async () => {
  const finishing: ModelProvider = {
    type: 'mock',
    descriptor: { type: 'mock', label: 'Mock', strategy: 'native' },
    async *stream(): AsyncIterable<ModelChunk> {
      yield { type: 'text', token: 'cut' };
      yield { type: 'finish', reason: 'length' }; // truncated, not a normal stop
    }
  };
  const router = new GatewayModelRouter(deps(), registryWith(finishing));
  const result = await router.complete({ model: 'default', messages: userMsg });
  expect(result.finishReason).toBe('length'); // real reason, not the tool-call/stop guess
});
