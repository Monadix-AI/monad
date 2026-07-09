'use client';

import type { SetToolBackendsRequest, ToolBackendsResponse } from '@monad/protocol';

import { useGetToolBackendsQuery, useSetToolBackendsMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface ToolBackendsSettingsStore {
  config: ToolBackendsResponse | undefined;
  loading: boolean;
  error?: string;
  save: (req: SetToolBackendsRequest) => Promise<void>;
  refetch: () => void;
}

export function useToolBackendsSettings(): ToolBackendsSettingsStore {
  const q = useGetToolBackendsQuery(undefined);
  const [setToolBackends] = useSetToolBackendsMutation();

  const save = useCallback(
    async (req: SetToolBackendsRequest) => {
      await setToolBackends(req).unwrap();
    },
    [setToolBackends]
  );

  return {
    config: q.data,
    loading: q.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'Failed to load tool settings') : undefined,
    save,
    refetch: () => {
      void q.refetch();
    }
  };
}
