import { createGateway } from '@ai-sdk/gateway';
import { vercelGatewayPrice } from '@monad/protocol';

import { defineAiSdkProvider } from './ai-sdk-adapter.ts';
import { PROVIDER_DESCRIPTORS } from './catalog.ts';

export const vercelGatewayProviderAtom = defineAiSdkProvider({
  type: 'vercel-gateway',
  descriptor: PROVIDER_DESCRIPTORS['vercel-gateway'],

  build(call) {
    return createGateway({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).languageModel(call.modelId);
  },

  buildEmbeddingModel(call) {
    return createGateway({
      apiKey: call.credential.accessToken,
      baseURL: call.credential.baseUrl ?? call.provider.baseUrl,
      fetch: call.fetch
    }).embeddingModel(call.modelId);
  },

  async listModels(provider, cred) {
    try {
      const { models } = await createGateway({
        apiKey: cred?.accessToken,
        baseURL: cred?.baseUrl ?? provider.baseUrl
      }).getAvailableModels();
      return models.map((m) => {
        const price = vercelGatewayPrice(m.pricing);
        return price ? { id: m.id, label: m.name, price } : { id: m.id, label: m.name };
      });
    } catch {
      return [];
    }
  }
});
