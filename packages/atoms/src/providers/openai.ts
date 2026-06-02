import { createOpenAI } from '@ai-sdk/openai';

import { defineAiSdkProvider, renderForCount } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

const client = (call: {
  credential: { accessToken: string; baseUrl?: string };
  provider: { baseUrl?: string };
  fetch?: typeof globalThis.fetch;
}) =>
  createOpenAI({
    apiKey: call.credential.accessToken,
    baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
    fetch: call.fetch
  });

export const openaiProviderAtom = defineAiSdkProvider({
  type: 'openai',
  descriptor: PROVIDER_DESCRIPTORS.openai,
  rateLimitHeaderStyle: 'openai',

  build(call) {
    return client(call).languageModel(call.modelId);
  },

  buildImageModel(call) {
    return client(call).image(call.modelId);
  },

  buildSpeechModel(call) {
    return client(call).speech(call.modelId);
  },

  buildEmbeddingModel(call) {
    return client(call).embeddingModel(call.modelId);
  },

  reasoningOptions(effort, _maxThinkingTokens) {
    return { openai: { reasoningEffort: effort } };
  },

  // OpenAI's Responses API exposes a server-side counter: POST /v1/responses/input_tokens →
  // { input_tokens }. (No equivalent on Chat Completions; tiktoken is the local-only alternative,
  // which we deliberately avoid.)
  async countTokens(call) {
    const input = renderForCount(call);
    if (!input.text) return undefined;
    try {
      const fetchImpl = call.fetch ?? globalThis.fetch;
      const base = (call.credential.baseUrl ?? call.provider.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const res = await fetchImpl(`${base}/responses/input_tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${call.credential.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: call.modelId,
          input: input.text,
          ...(input.system ? { instructions: input.system } : {})
        })
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { input_tokens?: unknown };
      return typeof json.input_tokens === 'number' && Number.isFinite(json.input_tokens)
        ? json.input_tokens
        : undefined;
    } catch {
      return undefined;
    }
  }
});
