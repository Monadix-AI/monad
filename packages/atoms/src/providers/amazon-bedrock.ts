import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

import { defineAiSdkProvider } from './ai-sdk-adapter/index.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

// Bedrock authenticates with a bearer API key (the long-lived `ABSK…` key) and requires a
// `region`, collected as a provider extra field. SigV4 is intentionally out of scope — the
// single-secret API-key path keeps Bedrock inside monad's credential model.
export const amazonBedrockProviderAtom = defineAiSdkProvider({
  type: 'amazon-bedrock',
  descriptor: PROVIDER_DESCRIPTORS['amazon-bedrock'],

  build(call) {
    const region = call.provider.extra?.region;
    if (!region) {
      throw new Error(`provider "${call.provider.id}" (amazon-bedrock) requires an AWS region (extra.region)`);
    }
    return createAmazonBedrock({
      region,
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    const region = call.provider.extra?.region;
    if (!region) {
      throw new Error(`provider "${call.provider.id}" (amazon-bedrock) requires an AWS region (extra.region)`);
    }
    return createAmazonBedrock({
      region,
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).embeddingModel(call.modelId);
  }
});
