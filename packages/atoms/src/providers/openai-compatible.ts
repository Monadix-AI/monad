import type { ModelProvider, ModelProviderDescriptor } from '@monad/sdk-atom';
import type { CountTokensInput } from './ai-sdk-adapter/index.ts';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { defineAiSdkProvider, renderForCount } from './ai-sdk-adapter/index.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

// A few OpenAI-compatible vendors ship a native count-tokens route over the same base URL +
// Bearer auth. Body shape differs by vendor. Providers absent here have no endpoint and map to
// `undefined`, falling back to the char heuristic.
interface CountTokensRoute {
  path: string;
  body: (modelId: string, input: CountTokensInput) => unknown;
  extract: (json: unknown) => unknown;
}

const messagesBody = (modelId: string, input: CountTokensInput) => ({
  model: modelId,
  messages: [
    ...(input.system ? [{ role: 'system', content: input.system }] : []),
    { role: 'user', content: input.text }
  ]
});
const responsesBody = (modelId: string, input: CountTokensInput) => ({
  model: modelId,
  input: input.text,
  ...(input.system ? { instructions: input.system } : {})
});

const COUNT_ROUTES: Record<string, CountTokensRoute> = {
  moonshot: {
    path: '/tokenizers/estimate-token-count',
    body: messagesBody,
    extract: (j) => (j as { data?: { total_tokens?: unknown } }).data?.total_tokens
  },
  zai: {
    path: '/tokenizer',
    body: messagesBody,
    extract: (j) => (j as { usage?: { total_tokens?: unknown } }).usage?.total_tokens
  },
  minimax: {
    path: '/responses/input_tokens',
    body: responsesBody,
    extract: (j) => (j as { input_tokens?: unknown }).input_tokens
  }
};

/** Build a provider that talks to any OpenAI-compatible endpoint. Resolution order for the base
 *  URL: credential → provider → the descriptor's `defaultBaseUrl` preset. */
export function makeOpenAICompatibleProvider(descriptor: ModelProviderDescriptor): ModelProvider {
  const type = descriptor.type;
  const preset = descriptor.defaultBaseUrl;
  return defineAiSdkProvider({
    type,
    descriptor,
    rateLimitHeaderStyle: 'openai',

    build(call) {
      const baseURL = call.credential.baseUrl ?? call.provider.baseUrl ?? preset;
      if (!baseURL) throw new Error(`provider "${call.provider.id}" (${type}) requires a baseUrl`);
      return createOpenAICompatible({
        name: call.provider.id,
        baseURL,
        apiKey: call.credential.accessToken,
        fetch: call.fetch
      }).languageModel(call.modelId);
    },

    buildEmbeddingModel(call) {
      const baseURL = call.credential.baseUrl ?? call.provider.baseUrl ?? preset;
      if (!baseURL) throw new Error(`provider "${call.provider.id}" (${type}) requires a baseUrl`);
      return createOpenAICompatible({
        name: call.provider.id,
        baseURL,
        apiKey: call.credential.accessToken,
        fetch: call.fetch
      }).embeddingModel(call.modelId);
    },

    async countTokens(call) {
      const route = COUNT_ROUTES[type];
      const input = renderForCount(call);
      if (!route || !input.text) return undefined;
      const baseURL = call.credential.baseUrl ?? call.provider.baseUrl ?? preset;
      if (!baseURL) return undefined;
      try {
        const fetchImpl = call.fetch ?? globalThis.fetch;
        const base = baseURL.replace(/\/$/, '');
        const res = await fetchImpl(`${base}${route.path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${call.credential.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(route.body(call.modelId, input))
        });
        if (!res.ok) return undefined;
        const n = route.extract(await res.json());
        return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
      } catch {
        return undefined;
      }
    }
  });
}

export const openaiCompatibleProviderAtom = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS['openai-compatible']);
export const cloudflareGatewayProviderAtom = makeOpenAICompatibleProvider(PROVIDER_DESCRIPTORS['cloudflare-gateway']);
