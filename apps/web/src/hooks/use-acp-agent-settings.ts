'use client';

import type { AcpAgentPresetView, AcpAgentView } from '@monad/protocol';

import {
  acpAgentAdapter,
  acpAgentSelectors,
  useDeleteAcpAgentMutation,
  useListAcpAgentPresetsQuery,
  useListAcpAgentsQuery,
  useUpsertAcpAgentMutation
} from '@monad/client-rtk';
import { useCallback } from 'react';

export interface AcpAgentSettingsStore {
  agents: AcpAgentView[];
  presets: AcpAgentPresetView[];
  loading: boolean;
  error?: string;
  saveAgent: (a: AcpAgentView) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  setEnabled: (a: AcpAgentView, enabled: boolean) => Promise<void>;
  refetch: () => void;
}

export function useAcpAgentSettings(): AcpAgentSettingsStore {
  const agentsQ = useListAcpAgentsQuery(undefined);
  const presetsQ = useListAcpAgentPresetsQuery(undefined);
  const [upsert] = useUpsertAcpAgentMutation();
  const [del] = useDeleteAcpAgentMutation();

  const saveAgent = useCallback(
    async (a: AcpAgentView) => {
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
    async (a: AcpAgentView, enabled: boolean) => {
      await upsert({ ...a, enabled }).unwrap();
    },
    [upsert]
  );

  return {
    agents: acpAgentSelectors.selectAll(agentsQ.data ?? acpAgentAdapter.getInitialState()),
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
