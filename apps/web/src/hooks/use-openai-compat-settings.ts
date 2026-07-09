'use client';

import type { OpenaiCompatSettings, SetOpenaiCompatRequest } from '@monad/protocol';

import { useGetOpenaiCompatQuery, useSetOpenaiCompatMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface OpenaiCompatSettingsStore {
  settings: OpenaiCompatSettings | undefined;
  loading: boolean;
  error?: string;
  set: (req: SetOpenaiCompatRequest) => Promise<void>;
  refetch: () => void;
}

export function useOpenaiCompatSettings(): OpenaiCompatSettingsStore {
  const q = useGetOpenaiCompatQuery(undefined);
  const [setOpenaiCompat] = useSetOpenaiCompatMutation();

  const set = useCallback(
    async (req: SetOpenaiCompatRequest) => {
      await setOpenaiCompat(req).unwrap();
    },
    [setOpenaiCompat]
  );

  return {
    settings: q.data,
    loading: q.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'failed to load') : undefined,
    set,
    refetch: () => {
      void q.refetch();
    }
  };
}
