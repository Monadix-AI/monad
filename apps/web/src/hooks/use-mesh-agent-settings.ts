import type { MeshAgentAuthState, MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import {
  meshAgentAdapter,
  meshAgentSelectors,
  useDeleteMeshAgentMutation,
  useLazyGetMeshAgentAuthStatusQuery,
  useListMeshAgentPresetsQuery,
  useListMeshAgentsQuery,
  useUpsertMeshAgentMutation
} from '@monad/client-rtk';
import { useCallback, useEffect, useMemo, useState } from 'react';

const AUTH_STATUS_CACHE_TTL_MS = 60_000;
const meshAgentAuthStatusCache = new Map<string, { state: MeshAgentAuthState; updatedAt: number }>();

function cachedAuthStatesFor(names: string[]): Record<string, MeshAgentAuthState> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const cached = meshAgentAuthStatusCache.get(name);
      return cached ? ([[name, cached.state]] as const) : [];
    })
  );
}

export function meshAgentAuthProbeNamesToRefresh({
  names,
  cachedAt,
  now,
  targetedNames,
  forceAll,
  ttlMs = AUTH_STATUS_CACHE_TTL_MS
}: {
  names: readonly string[];
  cachedAt: ReadonlyMap<string, number>;
  now: number;
  targetedNames?: readonly string[];
  forceAll?: boolean;
  ttlMs?: number;
}): string[] {
  const allowed = new Set(names);
  if (targetedNames) return [...new Set(targetedNames)].filter((name) => allowed.has(name)).sort();
  if (forceAll) return [...names].sort();
  return names.filter((name) => {
    const updatedAt = cachedAt.get(name);
    return updatedAt === undefined || now - updatedAt > ttlMs;
  });
}

export interface MeshAgentSettingsStore {
  agents: MeshAgentView[];
  presets: MeshAgentPresetView[];
  authStates: Record<string, MeshAgentAuthState>;
  loading: boolean;
  error?: string;
  saveAgent: (a: MeshAgentView) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  setEnabled: (a: MeshAgentView, enabled: boolean) => Promise<void>;
  refetch: () => void;
}

export function useMeshAgentSettings(): MeshAgentSettingsStore {
  const agentsQ = useListMeshAgentsQuery(undefined);
  const presetsQ = useListMeshAgentPresetsQuery(undefined);
  const [upsert] = useUpsertMeshAgentMutation();
  const [del] = useDeleteMeshAgentMutation();
  const [getAuthStatus] = useLazyGetMeshAgentAuthStatusQuery();
  const [authStates, setAuthStates] = useState<Record<string, MeshAgentAuthState>>(() =>
    cachedAuthStatesFor([...meshAgentAuthStatusCache.keys()])
  );
  const [authRefresh, setAuthRefresh] = useState<{ seq: number; names?: string[]; forceAll?: boolean }>({ seq: 0 });
  const agents = useMemo(
    () => meshAgentSelectors.selectAll(agentsQ.data ?? meshAgentAdapter.getInitialState()),
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
    const namesToProbe = meshAgentAuthProbeNamesToRefresh({
      names,
      cachedAt: new Map([...meshAgentAuthStatusCache].map(([name, cached]) => [name, cached.updatedAt])),
      now,
      targetedNames: authRefresh.names,
      forceAll: authRefresh.forceAll
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
      for (const [name, state] of entries) meshAgentAuthStatusCache.set(name, { state, updatedAt });
      if (!cancelled) setAuthStates({ ...cachedAuthStatesFor(names), ...Object.fromEntries(entries) });
    })();

    return () => {
      cancelled = true;
    };
  }, [authProbeNames, authRefresh, getAuthStatus]);

  const saveAgent = useCallback(
    async (a: MeshAgentView) => {
      await upsert(a).unwrap();
      setAuthRefresh(({ seq }) => ({ seq: seq + 1, names: [a.name] }));
    },
    [upsert]
  );
  const removeAgent = useCallback(
    async (name: string) => {
      await del(name).unwrap();
      meshAgentAuthStatusCache.delete(name);
    },
    [del]
  );
  const setEnabled = useCallback(
    async (a: MeshAgentView, enabled: boolean) => {
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
      setAuthRefresh(({ seq }) => ({ seq: seq + 1, forceAll: true }));
    }
  };
}
