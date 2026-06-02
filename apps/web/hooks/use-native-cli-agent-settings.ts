'use client';

import type { NativeCliAgentPresetView, NativeCliAgentView } from '@monad/protocol';

import {
  nativeCliAgentAdapter,
  nativeCliAgentSelectors,
  useDeleteNativeCliAgentMutation,
  useListNativeCliAgentPresetsQuery,
  useListNativeCliAgentsQuery,
  useUpsertNativeCliAgentMutation
} from '@monad/client-rtk';
import { useCallback } from 'react';

export interface NativeCliAgentSettingsStore {
  agents: NativeCliAgentView[];
  presets: NativeCliAgentPresetView[];
  loading: boolean;
  error?: string;
  saveAgent: (a: NativeCliAgentView) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  setEnabled: (a: NativeCliAgentView, enabled: boolean) => Promise<void>;
  refetch: () => void;
}

export function useNativeCliAgentSettings(): NativeCliAgentSettingsStore {
  const agentsQ = useListNativeCliAgentsQuery(undefined);
  const presetsQ = useListNativeCliAgentPresetsQuery(undefined);
  const [upsert] = useUpsertNativeCliAgentMutation();
  const [del] = useDeleteNativeCliAgentMutation();

  const saveAgent = useCallback(
    async (a: NativeCliAgentView) => {
      await upsert(a).unwrap();
    },
    [upsert]
  );
  const removeAgent = useCallback(
    async (name: string) => {
      await del(name).unwrap();
    },
    [del]
  );
  const setEnabled = useCallback(
    async (a: NativeCliAgentView, enabled: boolean) => {
      await upsert({ ...a, enabled }).unwrap();
    },
    [upsert]
  );

  return {
    agents: nativeCliAgentSelectors.selectAll(agentsQ.data ?? nativeCliAgentAdapter.getInitialState()),
    presets: presetsQ.data ?? [],
    loading: agentsQ.isLoading,
    error: agentsQ.error ? ((agentsQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveAgent,
    removeAgent,
    setEnabled,
    refetch: () => {
      void agentsQ.refetch();
      void presetsQ.refetch();
    }
  };
}
