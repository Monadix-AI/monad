import type { McpServerConfig, MonadConfig, MonadPaths } from '@monad/home';
import type {
  ListMcpCatalogResponse,
  ListMcpServerStatusResponse,
  ListMcpServersResponse,
  McpServerStatus,
  McpServerView,
  OkResponse,
  SearchMcpRegistryResponse,
  SetMcpServerEnabledRequest,
  UpsertMcpServerRequest
} from '@monad/protocol';

import { loadAll, saveSystemConfig } from '@monad/home';

import {
  BuiltInMcpAdapter,
  GlamaMcpAdapter,
  OfficialMcpAdapter,
  SmitheryMcpAdapter,
  searchMcpRegistry,
  toCatalogEntry
} from '@/capabilities/mcp/index.ts';

const REGISTRY_ADAPTERS = [
  new BuiltInMcpAdapter(),
  new OfficialMcpAdapter(),
  new GlamaMcpAdapter(),
  new SmitheryMcpAdapter()
];

export interface McpServerDeps {
  paths: MonadPaths;
  /** Live connection health (config + presets + file/pack + obscura). Absent in mock/test wiring. */
  getMcpStatus?: () => Promise<McpServerStatus[]>;
  /** Run interactive OAuth for a config http oauth server, then reconnect it. Absent in mock/test. */
  mcpAuthorize?: (name: string) => Promise<void>;
  /** Manually (re)connect a single config server (retry a boot-time failure). Absent in mock/test. */
  mcpReconnect?: (name: string) => Promise<void>;
}

// MCP servers are SYSTEM config (config.json). Edits persist via saveSystemConfig, which trips the
// settings file-watcher → configBus → diff-reconnect (connect added / disconnect removed / reconnect
// changed) — so a change applies live, no restart (see bootstrap/mcp.ts reloadConfigMcpServers). The
// view mirrors @monad/home's mcpServerSchema field-for-field; secret-bearing values are `${env:NAME}`
// refs by convention, so nothing is stripped. saveSystemConfig re-validates, so a bad shape is rejected.
const toView = (s: McpServerConfig): McpServerView => s as McpServerView;
const fromView = (v: McpServerView): McpServerConfig => v as McpServerConfig;

export function createMcpServerModule({ paths, getMcpStatus, mcpAuthorize, mcpReconnect }: McpServerDeps) {
  async function read(): Promise<MonadConfig> {
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('mcp-server settings: config.json missing');
    return cfg;
  }
  const commit = (cfg: MonadConfig): Promise<void> => saveSystemConfig(paths.config, cfg);

  return {
    async listMcpServers(): Promise<ListMcpServersResponse> {
      const cfg = await read();
      return { servers: cfg.mcpServers.map(toView) };
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

    // Live connection health (connected / disabled / failed + tool sets) across config, presets,
    // file/pack atoms, and obscura — distinct from listMcpServers' static config view.
    async listMcpServerStatus(): Promise<ListMcpServerStatusResponse> {
      return { servers: (await getMcpStatus?.()) ?? [] };
    },

    // Trigger the interactive OAuth flow for a config http oauth server (blocks until the browser/
    // device flow completes or times out), then reconnect it so the token takes effect.
    async authorizeMcpServer({ name }: { name: string }): Promise<OkResponse> {
      if (!mcpAuthorize) throw new Error('OAuth authorize is unavailable in this context');
      await mcpAuthorize(name);
      return { ok: true };
    },

    // Force a single server to (re)connect — retry a boot-time failure without a restart.
    async reconnectMcpServer({ name }: { name: string }): Promise<OkResponse> {
      if (!mcpReconnect) throw new Error('reconnect is unavailable in this context');
      await mcpReconnect(name);
      return { ok: true };
    },

    // Insert-or-replace by name (the server's identity).
    async upsertMcpServer({ server }: UpsertMcpServerRequest): Promise<OkResponse> {
      const cfg = await read();
      cfg.mcpServers = [...cfg.mcpServers.filter((s) => s.name !== server.name), fromView(server)];
      await commit(cfg);
      await applyLive(server.name);
      return { ok: true };
    },

    async setMcpServerEnabled({ name, enabled }: { name: string } & SetMcpServerEnabledRequest): Promise<OkResponse> {
      const cfg = await read();
      cfg.mcpServers = cfg.mcpServers.map((s) => (s.name === name ? { ...s, enabled } : s));
      await commit(cfg);
      await applyLive(name);
      return { ok: true };
    },

    async removeMcpServer({ name }: { name: string }): Promise<OkResponse> {
      const cfg = await read();
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
