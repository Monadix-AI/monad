import type { McpCatalogEntry, McpServerStatus, McpServerView } from '@monad/protocol';

import {
  mcpServerAdapter,
  mcpServerSelectors,
  useAuthorizeMcpServerMutation,
  useDeleteMcpServerMutation,
  useListMcpCatalogQuery,
  useListMcpServerStatusQuery,
  useListMcpServersQuery,
  useReconnectMcpServerMutation,
  useUpsertMcpServerMutation
} from '@monad/client-rtk';
import { useCallback } from 'react';

export interface McpServerSettingsStore {
  servers: McpServerView[];
  /** Live connection health by server name (disabled / starting / ready / failed + tools). */
  statusByName: Map<string, McpServerStatus>;
  /** Curated directory of popular MCP servers for one-click add. */
  catalog: McpCatalogEntry[];
  loading: boolean;
  refreshing: boolean;
  error?: string;
  saveServer: (s: McpServerView) => Promise<void>;
  removeServer: (name: string) => Promise<void>;
  setEnabled: (s: McpServerView, enabled: boolean) => Promise<void>;
  /** Run the interactive OAuth flow for an http oauth server (blocks until the daemon-host flow completes). */
  authorize: (name: string) => Promise<void>;
  /** Force one server to (re)connect — retry a boot-time failure. */
  reconnect: (name: string) => Promise<void>;
  refetch: () => void;
}

export function useMcpServerSettings(): McpServerSettingsStore {
  const serversQ = useListMcpServersQuery(undefined);
  const statusQ = useListMcpServerStatusQuery(undefined);
  const catalogQ = useListMcpCatalogQuery(undefined);
  const [upsert] = useUpsertMcpServerMutation();
  const [del] = useDeleteMcpServerMutation();
  const [authorizeMut] = useAuthorizeMcpServerMutation();
  const [reconnectMut] = useReconnectMcpServerMutation();

  const saveServer = useCallback(
    async (s: McpServerView) => {
      await upsert(s).unwrap();
    },
    [upsert]
  );
  const removeServer = useCallback(
    async (name: string) => {
      await del(name).unwrap();
    },
    [del]
  );
  const setEnabled = useCallback(
    async (s: McpServerView, enabled: boolean) => {
      await upsert({ ...s, enabled }).unwrap();
    },
    [upsert]
  );
  const authorize = useCallback(
    async (name: string) => {
      await authorizeMut(name).unwrap();
    },
    [authorizeMut]
  );
  const reconnect = useCallback(
    async (name: string) => {
      await reconnectMut(name).unwrap();
    },
    [reconnectMut]
  );

  return {
    servers: mcpServerSelectors.selectAll(serversQ.data ?? mcpServerAdapter.getInitialState()),
    statusByName: new Map((statusQ.data ?? []).map((s) => [s.name, s])),
    catalog: catalogQ.data ?? [],
    loading: serversQ.isLoading,
    refreshing: serversQ.isFetching || statusQ.isFetching || catalogQ.isFetching,
    error: serversQ.error ? ((serversQ.error as { message?: string }).message ?? 'failed to load') : undefined,
    saveServer,
    removeServer,
    setEnabled,
    authorize,
    reconnect,
    refetch: () => {
      void serversQ.refetch();
      void statusQ.refetch();
    }
  };
}
