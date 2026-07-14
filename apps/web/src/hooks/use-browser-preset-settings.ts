import type { BrowserPresetResponse, SetBrowserPresetRequest } from '@monad/protocol';

import { useGetBrowserPresetQuery, useSetBrowserPresetMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface BrowserPresetSettingsStore {
  config: BrowserPresetResponse | undefined;
  loading: boolean;
  error?: string;
  save: (req: SetBrowserPresetRequest) => Promise<void>;
  refetch: () => void;
}

export function useBrowserPresetSettings(): BrowserPresetSettingsStore {
  const q = useGetBrowserPresetQuery(undefined);
  const [setBrowserPreset] = useSetBrowserPresetMutation();

  const save = useCallback(
    async (req: SetBrowserPresetRequest) => {
      await setBrowserPreset(req).unwrap();
    },
    [setBrowserPreset]
  );

  return {
    config: q.data,
    loading: q.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'Failed to load browser preset') : undefined,
    save,
    refetch: () => {
      void q.refetch();
    }
  };
}
