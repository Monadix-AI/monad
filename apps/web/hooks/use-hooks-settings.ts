'use client';

import type { HooksSettingsResponse, SetHooksSettingsRequest } from '@monad/protocol';

import { useGetHooksQuery, useSetHooksMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface HooksSettingsStore {
  config: HooksSettingsResponse | undefined;
  loading: boolean;
  error?: string;
  save: (req: SetHooksSettingsRequest) => Promise<void>;
  refetch: () => void;
}

export function useHooksSettings(): HooksSettingsStore {
  const q = useGetHooksQuery(undefined);
  const [setHooks] = useSetHooksMutation();

  const save = useCallback(
    async (req: SetHooksSettingsRequest) => {
      await setHooks(req).unwrap();
    },
    [setHooks]
  );

  return {
    config: q.data,
    loading: q.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'Failed to load hooks') : undefined,
    save,
    refetch: () => {
      void q.refetch();
    }
  };
}
