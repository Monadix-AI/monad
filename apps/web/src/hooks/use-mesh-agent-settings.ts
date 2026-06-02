import type { MeshAgentAuthState, MeshAgentPresetView, MeshAgentView } from '@monad/protocol';

import {
  meshAgentAdapter,
  meshAgentSelectors,
  useDeleteMeshAgentMutation,
  useLazyGetMeshAgentAuthStatusQuery,
  useListMeshAgentPresetsQuery,
  useListMeshAgentsQuery,
  useRefreshMeshAgentCatalogMutation,
  useUpsertMeshAgentMutation
} from '@monad/client-rtk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  checkingAuth: Record<string, boolean>;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  saveAgent: (a: MeshAgentView) => Promise<void>;
  removeAgent: (name: string) => Promise<void>;
  setEnabled: (a: MeshAgentView, enabled: boolean) => Promise<void>;
  refetch: () => void;
}

interface MeshAgentAuthProbeState {
  states: Record<string, MeshAgentAuthState>;
  checking: Record<string, boolean>;
}

export function startMeshAgentAuthProbes(
  states: Record<string, MeshAgentAuthState>,
  names: readonly string[]
): MeshAgentAuthProbeState {
  return {
    states,
    checking: Object.fromEntries(names.map((name) => [name, true]))
  };
}

export function settleMeshAgentAuthProbe(
  current: MeshAgentAuthProbeState,
  name: string,
  state: MeshAgentAuthState
): MeshAgentAuthProbeState {
  const { [name]: _settled, ...checking } = current.checking;
  return {
    states: { ...current.states, [name]: state },
    checking
  };
}

export function meshAgentSettingsIsRefreshing({
  agentsFetching,
  presetsFetching,
  checkingAuth
}: {
  agentsFetching: boolean;
  presetsFetching: boolean;
  checkingAuth: Record<string, boolean>;
}): boolean {
  return agentsFetching || presetsFetching || Object.values(checkingAuth).some(Boolean);
}

export function useMeshAgentSettings(): MeshAgentSettingsStore {
  const agentsQ = useListMeshAgentsQuery(undefined);
  const presetsQ = useListMeshAgentPresetsQuery(undefined);
  const [upsert] = useUpsertMeshAgentMutation();
  const [del] = useDeleteMeshAgentMutation();
  const [refreshCatalog, refreshCatalogQ] = useRefreshMeshAgentCatalogMutation();
  const [getAuthStatus] = useLazyGetMeshAgentAuthStatusQuery();
  const [authProbe, setAuthProbe] = useState<MeshAgentAuthProbeState>(() => ({
    states: cachedAuthStatesFor([...meshAgentAuthStatusCache.keys()]),
    checking: {}
  }));
  const [authRefresh, setAuthRefresh] = useState<{ seq: number; names?: string[]; forceAll?: boolean }>({ seq: 0 });
  const authProbeGeneration = useRef(0);
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
    const generation = ++authProbeGeneration.current;
    const names = authProbeNames;
    if (names.length === 0) {
      setAuthProbe({ states: {}, checking: {} });
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
    setAuthProbe(startMeshAgentAuthProbes(cachedStates, namesToProbe));
    if (namesToProbe.length === 0) return;

    for (const name of namesToProbe) {
      void (async () => {
        let state: MeshAgentAuthState;
        try {
          const status = await getAuthStatus(name).unwrap();
          state = status.state;
        } catch {
          state = 'unknown';
        }
        if (cancelled || generation !== authProbeGeneration.current) return;
        meshAgentAuthStatusCache.set(name, { state, updatedAt: Date.now() });
        setAuthProbe((current) => settleMeshAgentAuthProbe(current, name, state));
      })();
    }

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
  const refetch = useCallback(() => {
    void refreshCatalog();
    setAuthRefresh(({ seq }) => ({ seq: seq + 1, forceAll: true }));
  }, [refreshCatalog]);

  return {
    agents,
    presets,
    authStates: authProbe.states,
    checkingAuth: authProbe.checking,
    loading: agentsQ.isLoading || presetsQ.isLoading,
    refreshing:
      meshAgentSettingsIsRefreshing({
        agentsFetching: agentsQ.isFetching,
        presetsFetching: presetsQ.isFetching,
        checkingAuth: authProbe.checking
      }) || refreshCatalogQ.isLoading,
    error: agentsQ.error ? ((agentsQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveAgent,
    removeAgent,
    setEnabled,
    refetch
  };
}
