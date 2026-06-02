import type { ModelService } from '@/services/model.ts';

export function createAtomKindsHandlers(providersDir: string, modelService: ModelService) {
  return {
    async listAtomKinds() {
      return { kinds: modelService.registry.types() };
    },

    async discoverAtomKinds() {
      return modelService.discoverProviders(providersDir);
    }
  };
}
