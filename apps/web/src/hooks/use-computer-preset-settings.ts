import type { ComputerPresetResponse, SetComputerPresetRequest } from '@monad/protocol';

import { useGetComputerPresetQuery, useSetComputerPresetMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface ComputerPresetSettingsStore {
  config: ComputerPresetResponse | undefined;
  loading: boolean;
  error?: string;
  save: (req: SetComputerPresetRequest) => Promise<void>;
  refetch: () => void;
}

export function useComputerPresetSettings(): ComputerPresetSettingsStore {
  const q = useGetComputerPresetQuery(undefined);
  const [setComputerPreset] = useSetComputerPresetMutation();

  const save = useCallback(
    async (req: SetComputerPresetRequest) => {
      await setComputerPreset(req).unwrap();
    },
    [setComputerPreset]
  );

  return {
    config: q.data,
    loading: q.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'Failed to load computer preset') : undefined,
    save,
    refetch: () => {
      void q.refetch();
    }
  };
}
