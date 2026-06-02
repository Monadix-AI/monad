import { createAzure } from '@ai-sdk/azure';

import { defineAiSdkProvider } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

// Azure OpenAI: the user supplies a resource base URL + an api-key; the model id is the Azure
// *deployment* name. apiVersion defaults to the SDK's current default.
export const azureProviderAtom = defineAiSdkProvider({
  type: 'azure',
  descriptor: PROVIDER_DESCRIPTORS.azure,
  rateLimitHeaderStyle: 'openai',

  build(call) {
    return createAzure({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createAzure({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).embeddingModel(call.modelId);
  }
});
