import type { ModelInfo } from '@monad/protocol';

import {
  modelAdapter,
  modelSelectors,
  providerAdapter,
  providerSelectors,
  useLazyListModelsQuery,
  useListProvidersQuery
} from '@monad/client-rtk';
import { useEffect, useMemo, useState } from 'react';

import { buildSessionModelProviders } from './session-model-options';

export function useSessionModelOptions() {
  const providersQuery = useListProvidersQuery(undefined);
  const providers = useMemo(
    () => providerSelectors.selectAll(providersQuery.data ?? providerAdapter.getInitialState()),
    [providersQuery.data]
  );
  const [loadModels] = useLazyListModelsQuery();
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        providers.map(async (provider) => {
          try {
            const result = await loadModels(provider.id, true).unwrap();
            return [provider.id, modelSelectors.selectAll(result ?? modelAdapter.getInitialState())] as const;
          } catch {
            return [provider.id, []] as const;
          }
        })
      );
      if (!cancelled) setModelsByProvider(Object.fromEntries(entries));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [loadModels, providers]);

  return useMemo(() => buildSessionModelProviders(providers, modelsByProvider), [modelsByProvider, providers]);
}
