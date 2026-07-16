import type { MonadPaths } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { McpServerStatus } from '@monad/protocol';
import type { ConfigAccess } from '#/config/manager.ts';
import type { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';

import { authorizeMcpOAuth } from '#/capabilities/mcp/oauth.ts';
import { type ConfigMcpHandle, collectMcpStatus, reconnectOneMcpServer, resolveConfigMcpSpecs } from './service.ts';

type CollectInput = Parameters<typeof collectMcpStatus>[0];

export function createMcpControls(deps: {
  paths: MonadPaths;
  registry: AtomPackRegistry;
  logger: Logger;
  getConfigMcp: () => ConfigMcpHandle;
  setConfigMcp: (v: ConfigMcpHandle) => void;
  fileMcpConnections: () => CollectInput['file'];
  obscuraStatus: () => CollectInput['obscura'];
  config: ConfigAccess;
}): {
  getMcpStatus: () => Promise<McpServerStatus[]>;
  mcpAuthorize: (name: string) => Promise<void>;
  mcpReconnect: (name: string) => Promise<void>;
} {
  const { paths, registry, logger, getConfigMcp, setConfigMcp, fileMcpConnections, obscuraStatus, config } = deps;

  // Live MCP connection health (config + presets + file/pack + obscura), for the status endpoint.
  const getMcpStatus = async (): Promise<McpServerStatus[]> => {
    const live = config.get().cfg;
    return collectMcpStatus({
      cfg: live,
      config: getConfigMcp().connections,
      configStatus: getConfigMcp().status,
      file: fileMcpConnections(),
      obscura: obscuraStatus()
    });
  };

  // Interactive OAuth for a config http oauth server (loopback opens the daemon-host browser; device
  // logs a code+URL), then force-reconnect it so the freshly-stored token takes effect — no restart.
  const mcpAuthorize = async (name: string): Promise<void> => {
    const live = config.get().cfg;
    const spec = resolveConfigMcpSpecs(live).find((s) => s.name === name);
    if (spec?.transport !== 'http') {
      throw new Error(`MCP server "${name}" is not an http server`);
    }
    await authorizeMcpOAuth({
      serverName: spec.name,
      serverUrl: spec.url,
      config,
      ...(spec.auth.mode === 'oauth'
        ? { clientId: spec.auth.clientId, scopes: spec.auth.scopes, flow: spec.auth.flow }
        : {}),
      log: (m) => logger.info(m)
    });
    const freshAuth = config.get().auth ?? undefined;
    const configMcp = getConfigMcp();
    setConfigMcp(await reconnectOneMcpServer(name, configMcp, live, paths, registry, freshAuth, config));
  };

  // Manually (re)connect a single config server — retry a server that was down at boot, without a
  // restart or bouncing the others.
  const mcpReconnect = async (name: string): Promise<void> => {
    const live = config.get().cfg;
    const freshAuth = config.get().auth ?? undefined;
    const configMcp = getConfigMcp();
    setConfigMcp(await reconnectOneMcpServer(name, configMcp, live, paths, registry, freshAuth, config));
  };

  return { getMcpStatus, mcpAuthorize, mcpReconnect };
}
