import type { NetworkSettings, SetNetworkSettingsRequest } from '@monad/protocol';

import { useGetNetworkQuery, useSetNetworkMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface NetworkSettingsStore {
  settings: NetworkSettings | undefined;
  loading: boolean;
  saving: boolean;
  error?: string;
  set: (req: SetNetworkSettingsRequest) => Promise<NetworkSettings>;
  refetch: () => void;
}

export function useNetworkSettings(): NetworkSettingsStore {
  const q = useGetNetworkQuery(undefined);
  const [setNetwork, mutation] = useSetNetworkMutation();

  const set = useCallback(async (req: SetNetworkSettingsRequest) => setNetwork(req).unwrap(), [setNetwork]);

  return {
    settings: q.data,
    loading: q.isLoading,
    saving: mutation.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'failed to load') : undefined,
    set,
    refetch: () => {
      void q.refetch();
    }
  };
}
