'use client';

import type { FrameworkAgentView } from '@monad/protocol';

import {
  frameworkAgentAdapter,
  frameworkAgentSelectors,
  useListFrameworkAgentsQuery,
  useRemoveFrameworkAgentMutation,
  useSetFrameworkAgentEnabledMutation,
  useUpsertFrameworkAgentMutation
} from '@monad/client-rtk';
import { useCallback } from 'react';

export interface FrameworkAgentSettingsStore {
  agents: FrameworkAgentView[];
  loading: boolean;
  error?: string;
  saveAgent: (a: FrameworkAgentView) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  setEnabled: (a: FrameworkAgentView, enabled: boolean) => Promise<void>;
  refetch: () => void;
}

export function useFrameworkAgentSettings(): FrameworkAgentSettingsStore {
  const agentsQ = useListFrameworkAgentsQuery(undefined);
  const [upsert] = useUpsertFrameworkAgentMutation();
  const [setEnabledMutation] = useSetFrameworkAgentEnabledMutation();
  const [del] = useRemoveFrameworkAgentMutation();

  const saveAgent = useCallback(
    async (a: FrameworkAgentView) => {
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
    async (a: FrameworkAgentView, enabled: boolean) => {
      await setEnabledMutation({ name: a.name, enabled }).unwrap();
    },
    [setEnabledMutation]
  );

  return {
    agents: frameworkAgentSelectors.selectAll(agentsQ.data ?? frameworkAgentAdapter.getInitialState()),
    loading: agentsQ.isLoading,
    error: agentsQ.error ? ((agentsQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveAgent,
    removeAgent,
    setEnabled,
    refetch: () => {
      void agentsQ.refetch();
    }
  };
}
