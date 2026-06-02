import type { ObscuraStatusResponse, SetObscuraRequest } from '@monad/protocol';

import { useGetObscuraQuery, useSetObscuraMutation } from '@monad/client-rtk';
import { useCallback } from 'react';

export interface ObscuraSettingsStore {
  status: ObscuraStatusResponse | undefined;
  loading: boolean;
  error?: string;
  enable: (opts?: { stealth?: boolean }) => Promise<void>;
  disable: () => Promise<void>;
  set: (req: SetObscuraRequest) => Promise<void>;
  refetch: () => void;
}

export function useObscuraSettings(): ObscuraSettingsStore {
  const q = useGetObscuraQuery(undefined);
  const [setObscura] = useSetObscuraMutation();

  const set = useCallback(
    async (req: SetObscuraRequest) => {
      await setObscura(req).unwrap();
    },
    [setObscura]
  );

  const enable = useCallback(
    async (opts?: { stealth?: boolean }) => {
      await setObscura({ enabled: true, stealth: opts?.stealth ?? false }).unwrap();
    },
    [setObscura]
  );

  const disable = useCallback(async () => {
    await setObscura({ enabled: false }).unwrap();
  }, [setObscura]);

  return {
    status: q.data,
    loading: q.isLoading,
    error: q.error ? ((q.error as { message?: string }).message ?? 'failed to load') : undefined,
    enable,
    disable,
    set,
    refetch: () => {
      void q.refetch();
    }
  };
}
