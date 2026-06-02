import type { McpServerConfig, MonadConfig } from '@monad/environment';
import type {
  GetMcpServerResponse,
  GetMcpTaskResponse,
  ListMcpCatalogResponse,
  ListMcpServerStatusResponse,
  ListMcpServersResponse,
  McpServerStatus,
  McpServerView,
  McpServerWrite,
  OkResponse,
  SearchMcpRegistryResponse,
  SetMcpServerEnabledRequest,
  UpsertMcpServerRequest
} from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';

import {
  BuiltInMcpAdapter,
  GlamaMcpAdapter,
  OfficialMcpAdapter,
  SmitheryMcpAdapter,
  searchMcpRegistry,
  toCatalogEntry
} from '#/capabilities/mcp/index.ts';
import { HandlerError } from '#/handlers/handler-error.ts';

const REGISTRY_ADAPTERS = [
  new BuiltInMcpAdapter(),
  new OfficialMcpAdapter(),
  new GlamaMcpAdapter(),
  new SmitheryMcpAdapter()
];

export interface McpServerDeps {
  config: ConfigAccess;
  /** Live connection health (config + presets + file/pack + obscura). Absent in mock/test wiring. */
  getMcpStatus?: () => Promise<McpServerStatus[]>;
  /** Run interactive OAuth for a config http oauth server, then reconnect it. Absent in mock/test. */
  mcpAuthorize?: (name: string) => Promise<void>;
  /** Manually (re)connect a single config server (retry a boot-time failure). Absent in mock/test. */
  mcpReconnect?: (name: string) => Promise<void>;
  mcpTaskObserve?: (name: string, taskId: string) => Promise<GetMcpTaskResponse['task']>;
  mcpTaskCancel?: (name: string, taskId: string) => Promise<GetMcpTaskResponse['task']>;
}

const configured = (value: string | undefined) => ({ configured: value !== undefined && value.length > 0 });

const toView = (server: McpServerConfig): McpServerView => {
  if (server.transport === 'stdio') return server;
  const auth =
    server.auth.mode === 'bearer'
      ? { mode: 'bearer' as const, token: configured(server.auth.token) }
      : server.auth.mode === 'headers'
        ? {
            mode: 'headers' as const,
            headers: Object.fromEntries(
              Object.entries(server.auth.headers).map(([name, value]) => [name, configured(value)])
            )
          }
        : server.auth;
  return {
    name: server.name,
    transport: 'http',
    url: server.url,
    auth,
    headers: server.headers
      ? Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, configured(value)]))
      : undefined,
    oauth: server.oauth
      ? {
          clientId: server.oauth.clientId,
          accessToken: configured(server.oauth.accessToken),
          refreshToken: configured(server.oauth.refreshToken),
          expiresAt: server.oauth.expiresAt,
          tokenEndpoint: server.oauth.tokenEndpoint,
          resource: server.oauth.resource
        }
      : undefined,
    requestTimeoutMs: server.requestTimeoutMs,
    enabled: server.enabled,
    trust: server.trust
  };
};

function applyUpdates(
  current: Record<string, string> | undefined,
  updates: Record<string, { action: 'replace'; value: string } | { action: 'remove' }> | undefined
): Record<string, string> | undefined {
  if (!updates) return current;
  const next = { ...(current ?? {}) };
  for (const [name, update] of Object.entries(updates)) {
    if (update.action === 'replace') next[name] = update.value;
    else delete next[name];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function fromWrite(server: McpServerWrite, existing?: McpServerConfig): McpServerConfig {
  if (server.transport === 'stdio') return server;
  const previous = existing?.transport === 'http' ? existing : undefined;
  const auth =
    server.auth.mode === 'bearer'
      ? server.auth.token?.action === 'replace'
        ? { mode: 'bearer' as const, token: server.auth.token.value }
        : server.auth.token?.action === 'remove'
          ? { mode: 'none' as const }
          : previous?.auth.mode === 'bearer'
            ? previous.auth
            : (() => {
                throw new HandlerError('invalid', 'a new bearer MCP server requires an explicit token replacement');
              })()
      : server.auth.mode === 'headers'
        ? {
            mode: 'headers' as const,
            headers:
              applyUpdates(
                previous?.auth.mode === 'headers' ? previous.auth.headers : undefined,
                server.auth.headers
              ) ?? {}
          }
        : server.auth;
  return {
    name: server.name,
    transport: 'http',
    url: server.url,
    auth,
    headers: applyUpdates(previous?.headers, server.headers),
    oauth: server.oauth?.action === 'remove' ? undefined : previous?.oauth,
    requestTimeoutMs: server.requestTimeoutMs,
    enabled: server.enabled,
    trust: server.trust
  };
}

export function createMcpServerModule({
  config,
  getMcpStatus,
  mcpAuthorize,
  mcpReconnect,
  mcpTaskObserve,
  mcpTaskCancel
}: McpServerDeps) {
  async function read(): Promise<MonadConfig> {
    return structuredClone(config.get().cfg);
  }
  const commit = (cfg: MonadConfig): Promise<unknown> => config.updateConfig(() => cfg);

  return {
    async listMcpServers(): Promise<ListMcpServersResponse> {
      const cfg = await read();
      return { servers: cfg.mcpServers.map(toView) };
    },

    async getMcpServer({ name }: { name: string }): Promise<GetMcpServerResponse> {
      const cfg = await read();
      const found = cfg.mcpServers.find((s) => s.name === name);
      if (!found) throw new HandlerError('not_found', `MCP server not found: ${name}`);
      return { server: toView(found) };
    },

    // Curated directory of popular MCP servers for one-click add. Falls back to built-in list when
    // all remote registries fail.
    async listMcpCatalog(): Promise<ListMcpCatalogResponse> {
      const entries = await searchMcpRegistry('', REGISTRY_ADAPTERS, { limit: 20 });
      return { entries: entries.map(toCatalogEntry) };
    },

    async searchMcpRegistry(query: string): Promise<SearchMcpRegistryResponse> {
      const entries = await searchMcpRegistry(query, REGISTRY_ADAPTERS, { limit: 30 });
      return { entries, query };
    },

    // Live connection health (disabled / starting / ready / failed + tool sets) across config, presets,
    // file/pack atoms, and obscura — distinct from listMcpServers' static config view.
    async listMcpServerStatus(): Promise<ListMcpServerStatusResponse> {
      return { servers: (await getMcpStatus?.()) ?? [] };
    },

    // Trigger the interactive OAuth flow for a config http oauth server (blocks until the browser/
    // device flow completes or times out), then reconnect it so the token takes effect.
    async authorizeMcpServer({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      if (!cfg.mcpServers.some((s) => s.name === name)) {
        throw new HandlerError('not_found', `MCP server not found: ${name}`);
      }
      if (!mcpAuthorize) throw new Error('OAuth authorize is unavailable in this context');
      await mcpAuthorize(name);
      return { ok: true };
    },

    // Force a single server to (re)connect — retry a boot-time failure without a restart.
    async reconnectMcpServer({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      if (!cfg.mcpServers.some((s) => s.name === name)) {
        throw new HandlerError('not_found', `MCP server not found: ${name}`);
      }
      if (!mcpReconnect) throw new Error('reconnect is unavailable in this context');
      await mcpReconnect(name);
      return { ok: true };
    },

    async getMcpTask({ name, taskId }: { name: string; taskId: string }): Promise<GetMcpTaskResponse> {
      if (!mcpTaskObserve) throw new Error('MCP Task observation is unavailable in this context');
      return { task: await mcpTaskObserve(name, taskId) };
    },

    async cancelMcpTask({ name, taskId }: { name: string; taskId: string }): Promise<GetMcpTaskResponse> {
      if (!mcpTaskCancel) throw new Error('MCP Task cancellation is unavailable in this context');
      return { task: await mcpTaskCancel(name, taskId) };
    },

    // Insert-or-replace by name (the server's identity).
    async upsertMcpServer({ server }: UpsertMcpServerRequest): Promise<OkResponse> {
      const cfg = await read();
      const existing = cfg.mcpServers.find((candidate) => candidate.name === server.name);
      cfg.mcpServers = [...cfg.mcpServers.filter((s) => s.name !== server.name), fromWrite(server, existing)];
      await commit(cfg);
      await applyLive(server.name);
      return { ok: true };
    },

    async setMcpServerEnabled({ name, enabled }: { name: string } & SetMcpServerEnabledRequest): Promise<OkResponse> {
      const cfg = await read();
      if (!cfg.mcpServers.some((s) => s.name === name)) {
        throw new HandlerError('not_found', `MCP server not found: ${name}`);
      }
      cfg.mcpServers = cfg.mcpServers.map((s) => (s.name === name ? { ...s, enabled } : s));
      await commit(cfg);
      await applyLive(name);
      return { ok: true };
    },

    async removeMcpServer({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
      if (!cfg.mcpServers.some((s) => s.name === name)) {
        throw new HandlerError('not_found', `MCP server not found: ${name}`);
      }
      cfg.mcpServers = cfg.mcpServers.filter((s) => s.name !== name);
      await commit(cfg);
      await applyLive(name);
      return { ok: true };
    }
  };

  // Apply a config mutation to the live connection set immediately via the same single-server
  // (re)connect the reconnect endpoint uses — which is interactive, so adding/enabling an OAuth
  // server triggers the browser, while disable/remove just disconnect. The file-watcher's diff-
  // reload still fires but is silent (no browser), so it never double-prompts. Absent in tests.
  async function applyLive(name: string): Promise<void> {
    if (mcpReconnect) await mcpReconnect(name);
  }
}
