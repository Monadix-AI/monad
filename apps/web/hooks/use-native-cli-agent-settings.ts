'use client';

import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliAuthState } from '@monad/protocol';

import {
  nativeCliAgentAdapter,
  nativeCliAgentSelectors,
  useDeleteNativeCliAgentMutation,
  useLazyGetNativeCliAuthStatusQuery,
  useListNativeCliAgentPresetsQuery,
  useListNativeCliAgentsQuery,
  useUpsertNativeCliAgentMutation
} from '@monad/client-rtk';
import { useCallback, useEffect, useMemo, useState } from 'react';

const AUTH_STATUS_CACHE_TTL_MS = 60_000;
const nativeCliAuthStatusCache = new Map<string, { state: NativeCliAuthState; updatedAt: number }>();

function cachedAuthStatesFor(names: string[]): Record<string, NativeCliAuthState> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const cached = nativeCliAuthStatusCache.get(name);
      return cached ? ([[name, cached.state]] as const) : [];
    })
  );
}

export interface NativeCliAgentSettingsStore {
  agents: NativeCliAgentView[];
  presets: NativeCliAgentPresetView[];
  authStates: Record<string, NativeCliAuthState>;
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
  const [getAuthStatus] = useLazyGetNativeCliAuthStatusQuery();
  const [authStates, setAuthStates] = useState<Record<string, NativeCliAuthState>>(() =>
    cachedAuthStatesFor([...nativeCliAuthStatusCache.keys()])
  );
  const [authRefreshSeq, setAuthRefreshSeq] = useState(0);
  const agents = useMemo(
    () => nativeCliAgentSelectors.selectAll(agentsQ.data ?? nativeCliAgentAdapter.getInitialState()),
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
            const cached = nativeCliAuthStatusCache.get(name);
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
      for (const [name, state] of entries) nativeCliAuthStatusCache.set(name, { state, updatedAt });
      if (!cancelled) setAuthStates({ ...cachedAuthStatesFor(names), ...Object.fromEntries(entries) });
    })();

    return () => {
      cancelled = true;
    };
  }, [authProbeNames, authRefreshSeq, getAuthStatus]);

  const saveAgent = useCallback(
    async (a: NativeCliAgentView) => {
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
    async (a: NativeCliAgentView, enabled: boolean) => {
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
