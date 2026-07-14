import type { MonadConfig, MonadPaths } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { McpServerStatus } from '@monad/protocol';
import type { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';

import { loadAll, loadAuth } from '@monad/home';

import { authorizeMcpOAuth } from '#/capabilities/mcp/oauth.ts';
import { type ConfigMcpHandle, collectMcpStatus, reconnectOneMcpServer, resolveConfigMcpSpecs } from './service.ts';

type CollectInput = Parameters<typeof collectMcpStatus>[0];

export function createMcpControls(deps: {
  paths: MonadPaths;
  cfg: MonadConfig;
  registry: AtomPackRegistry;
  logger: Logger;
  getConfigMcp: () => ConfigMcpHandle;
  setConfigMcp: (v: ConfigMcpHandle) => void;
  fileMcpConnections: () => CollectInput['file'];
  obscuraStatus: () => CollectInput['obscura'];
}): {
  getMcpStatus: () => Promise<McpServerStatus[]>;
  mcpAuthorize: (name: string) => Promise<void>;
  mcpReconnect: (name: string) => Promise<void>;
} {
  const { paths, cfg, registry, logger, getConfigMcp, setConfigMcp, fileMcpConnections, obscuraStatus } = deps;

  // Live MCP connection health (config + presets + file/pack + obscura), for the status endpoint.
  // Re-reads config off disk so a just-disabled/added server shows even before the next status poll;
  // falls back to the boot config mid-write.
  const getMcpStatus = async (): Promise<McpServerStatus[]> => {
    const live = (await loadAll(paths.config, paths.profile)) ?? cfg;
    return collectMcpStatus({
      cfg: live,
      config: getConfigMcp().connections,
      file: fileMcpConnections(),
      obscura: obscuraStatus()
    });
  };

  // Interactive OAuth for a config http oauth server (loopback opens the daemon-host browser; device
  // logs a code+URL), then force-reconnect it so the freshly-stored token takes effect — no restart.
  const mcpAuthorize = async (name: string): Promise<void> => {
    const live = (await loadAll(paths.config, paths.profile)) ?? cfg;
    const spec = resolveConfigMcpSpecs(live).find((s) => s.name === name);
    if (spec?.transport !== 'http') {
      throw new Error(`MCP server "${name}" is not an http server`);
    }
    await authorizeMcpOAuth({
      serverName: spec.name,
      serverUrl: spec.url,
      authPath: paths.auth,
      ...(spec.auth.mode === 'oauth'
        ? { clientId: spec.auth.clientId, scopes: spec.auth.scopes, flow: spec.auth.flow }
        : {}),
      log: (m) => logger.info(m)
    });
    const freshAuth = (await loadAuth(paths.auth)) ?? undefined;
    const configMcp = getConfigMcp();
    setConfigMcp({
      ...configMcp,
      connections: await reconnectOneMcpServer(name, configMcp.connections, live, paths, registry, freshAuth)
    });
  };

  // Manually (re)connect a single config server — retry a server that was down at boot, without a
  // restart or bouncing the others.
  const mcpReconnect = async (name: string): Promise<void> => {
    const live = (await loadAll(paths.config, paths.profile)) ?? cfg;
    const freshAuth = (await loadAuth(paths.auth)) ?? undefined;
    const configMcp = getConfigMcp();
    setConfigMcp({
      ...configMcp,
      connections: await reconnectOneMcpServer(name, configMcp.connections, live, paths, registry, freshAuth)
    });
  };

  return { getMcpStatus, mcpAuthorize, mcpReconnect };
}
