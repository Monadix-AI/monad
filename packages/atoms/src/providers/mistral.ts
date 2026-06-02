import { createMistral } from '@ai-sdk/mistral';

import { defineAiSdkProvider } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

export const mistralProviderAtom = defineAiSdkProvider({
  type: 'mistral',
  descriptor: PROVIDER_DESCRIPTORS.mistral,
  rateLimitHeaderStyle: 'openai',

  build(call) {
    return createMistral({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createMistral({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).embeddingModel(call.modelId);
  }
});
