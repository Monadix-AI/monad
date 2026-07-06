import type { MonadAuth, MonadConfig } from '@monad/home';
import type { ModelContext } from '@/handlers/settings/model/context.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/home';
import { ModelProviderType } from '@monad/protocol';

import { ModelProviderRegistry } from '@/agent/index.ts';
import { enrichModelInfo } from '@/handlers/settings/model/utils.ts';

function modelContextWithCatalogContextLimit(limit?: number): ModelContext {
  return {
    read: async () => ({ auth: {} as MonadAuth, cfg: createDefaultConfig('prn_test', 'Test') }),
    commit: async () => {},
    commitAuth: async () => {},
    providerModelCachePath: '/dev/null/provider-models.json',
    registry: new ModelProviderRegistry(),
    lookupPriceExact: () => undefined,
    lookupContextLimit: () => limit,
    lookupReleaseDate: () => undefined,
    lookupModelsDevUrl: () => undefined,
    lookupLabel: () => undefined,
    lookupCapabilities: () => undefined
  };
}

test('enrichModelInfo drops non-positive provider context limits and uses catalog fallback', () => {
  const cfg = createDefaultConfig('prn_test', 'Test') as MonadConfig;
  const provider = { id: 'openrouter', type: ModelProviderType.OpenRouter };

  expect(
    enrichModelInfo(modelContextWithCatalogContextLimit(128000), cfg, provider, {
      id: 'provider/model',
      contextLimit: 0
    })
  ).toMatchObject({ contextLimit: 128000 });
});
