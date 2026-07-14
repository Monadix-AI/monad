import type { ExternalAgentAuthState, ExternalAgentPresetView, ExternalAgentView } from '@monad/protocol';

import {
  externalAgentAdapter,
  externalAgentSelectors,
  useDeleteExternalAgentMutation,
  useLazyGetExternalAgentAuthStatusQuery,
  useListExternalAgentPresetsQuery,
  useListExternalAgentsQuery,
  useUpsertExternalAgentMutation
} from '@monad/client-rtk';
import { useCallback, useEffect, useMemo, useState } from 'react';

const AUTH_STATUS_CACHE_TTL_MS = 60_000;
const externalAgentAuthStatusCache = new Map<string, { state: ExternalAgentAuthState; updatedAt: number }>();

function cachedAuthStatesFor(names: string[]): Record<string, ExternalAgentAuthState> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const cached = externalAgentAuthStatusCache.get(name);
      return cached ? ([[name, cached.state]] as const) : [];
    })
  );
}

export interface ExternalAgentSettingsStore {
  agents: ExternalAgentView[];
  presets: ExternalAgentPresetView[];
  authStates: Record<string, ExternalAgentAuthState>;
  loading: boolean;
  error?: string;
  saveAgent: (a: ExternalAgentView) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  setEnabled: (a: ExternalAgentView, enabled: boolean) => Promise<void>;
  refetch: () => void;
}

export function useExternalAgentSettings(): ExternalAgentSettingsStore {
  const agentsQ = useListExternalAgentsQuery(undefined);
  const presetsQ = useListExternalAgentPresetsQuery(undefined);
  const [upsert] = useUpsertExternalAgentMutation();
  const [del] = useDeleteExternalAgentMutation();
  const [getAuthStatus] = useLazyGetExternalAgentAuthStatusQuery();
  const [authStates, setAuthStates] = useState<Record<string, ExternalAgentAuthState>>(() =>
    cachedAuthStatesFor([...externalAgentAuthStatusCache.keys()])
  );
  const [authRefreshSeq, setAuthRefreshSeq] = useState(0);
  const agents = useMemo(
    () => externalAgentSelectors.selectAll(agentsQ.data ?? externalAgentAdapter.getInitialState()),
    [agentsQ.data]
  );
  const presets = useMemo(() => presetsQ.data ?? [], [presetsQ.data]);
  const authProbeNames = useMemo(() => {
    const installedPresetNames = new Set(presets.filter((preset) => preset.installed).map((preset) => preset.id));
    return agents
      .filter((agent) => installedPresetNames.has(agent.name))
      .map((agent) => agent.name)
      .sort();
  }, [agents, presets]);

  useEffect(() => {
    let cancelled = false;
    const names = authProbeNames;
    if (names.length === 0) {
      setAuthStates({});
      return;
    }
    const now = Date.now();
    const cachedStates = cachedAuthStatesFor(names);
    const namesToProbe =
      authRefreshSeq > 0
        ? names
        : names.filter((name) => {
            const cached = externalAgentAuthStatusCache.get(name);
            return !cached || now - cached.updatedAt > AUTH_STATUS_CACHE_TTL_MS;
          });
    setAuthStates(cachedStates);
    if (namesToProbe.length === 0) return;

    void (async () => {
      const entries = await Promise.all(
        namesToProbe.map(async (name) => {
          try {
            const status = await getAuthStatus(name).unwrap();
            return [name, status.state] as const;
          } catch {
            return [name, 'unknown'] as const;
          }
        })
      );
      const updatedAt = Date.now();
      for (const [name, state] of entries) externalAgentAuthStatusCache.set(name, { state, updatedAt });
      if (!cancelled) setAuthStates({ ...cachedAuthStatesFor(names), ...Object.fromEntries(entries) });
    })();

    return () => {
      cancelled = true;
    };
  }, [authProbeNames, authRefreshSeq, getAuthStatus]);

  const saveAgent = useCallback(
    async (a: ExternalAgentView) => {
      await upsert(a).unwrap();
      setAuthRefreshSeq((seq) => seq + 1);
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
    async (a: ExternalAgentView, enabled: boolean) => {
      await upsert({ ...a, enabled }).unwrap();
    },
    [upsert]
  );

  return {
    agents,
    presets,
    authStates,
    loading: agentsQ.isLoading || presetsQ.isLoading,
    error: agentsQ.error ? ((agentsQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveAgent,
    removeAgent,
    setEnabled,
    refetch: () => {
      void agentsQ.refetch();
      void presetsQ.refetch();
      setAuthRefreshSeq((seq) => seq + 1);
    }
  };
}
