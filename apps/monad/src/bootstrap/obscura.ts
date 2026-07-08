// Boot phase: the Obscura MCP controller — connect / disconnect / status for the optional Obscura
// stdio MCP server, behind a trust gate (pinned tool-set hash + per-tool auto-approve). Held as a
// single live connection so a reconnect closes the prior one and a tool-set change is refused unless
// re-pinned. Returns the three handles startDaemon hands to createDaemonHandlers.

import type { ObscuraConfig } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { McpConnection } from '#/capabilities/tools';

import { connectMcpServer } from '#/capabilities/tools';
import { buildObscuraMcpServer } from '#/config/mcp-presets.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import { fingerprintToolset } from './mcp.ts';

export interface ObscuraController {
  connectObscura: (config: ObscuraConfig, command: string) => Promise<{ connected: boolean; tools: string[] }>;
  disconnectObscura: () => Promise<void>;
  getObscuraStatus: () => { connected: boolean; tools: string[] };
}

export function createObscuraController(deps: { registry: AtomPackRegistry; log: Logger }): ObscuraController {
  const { registry, log } = deps;
  let liveObscuraConn: McpConnection | null = null;

  const connectObscura = async (
    config: ObscuraConfig,
    command: string
  ): Promise<{ connected: boolean; tools: string[] }> => {
    if (liveObscuraConn) {
      registry.clearToolsFrom('obscura');
      await liveObscuraConn.close();
      liveObscuraConn = null;
    }
    const spec = buildObscuraMcpServer(config, command);
    if (spec.transport === 'http') throw new Error('Obscura spec must be stdio transport');
    const conn = await connectMcpServer({
      name: spec.name,
      command: spec.command,
      args: spec.args,
      requestTimeoutMs: config.requestTimeoutMs
    });

    const hash = fingerprintToolset(conn.tools);
    if (spec.trust.pinnedToolHash && spec.trust.pinnedToolHash !== hash) {
      log.warn(
        `monad: Obscura tool set changed (pinned ${spec.trust.pinnedToolHash.slice(0, 12)}… ≠ ${hash.slice(0, 12)}…) — refusing to register. Re-pin trust.pinnedToolHash to accept.`
      );
      await conn.close();
      return { connected: false, tools: [] };
    }
    if (!spec.trust.pinnedToolHash) {
      log.info(`monad: Obscura unpinned — set trust.pinnedToolHash="${hash}" to lock this tool set`);
    }

    const advertised = new Set(conn.tools.map((t) => t.name));
    for (const approved of spec.trust.autoApproveTools) {
      if (!advertised.has(approved)) {
        log.warn(
          `monad: Obscura autoApproveTools entry "${approved}" matches no advertised tool — it has no effect. Advertised: ${[...advertised].join(', ')}`
        );
      }
    }

    const tools = conn.tools.map((t) => (spec.trust.autoApproveTools.includes(t.name) ? { ...t, highRisk: false } : t));
    for (const t of tools) registry.registerTool(t, 'obscura');
    liveObscuraConn = conn;
    return { connected: true, tools: conn.tools.map((t) => t.name) };
  };

  const disconnectObscura = async (): Promise<void> => {
    if (liveObscuraConn) {
      registry.clearToolsFrom('obscura');
      await liveObscuraConn.close();
      liveObscuraConn = null;
    }
  };

  const getObscuraStatus = (): { connected: boolean; tools: string[] } =>
    liveObscuraConn
      ? { connected: true, tools: liveObscuraConn.tools.map((t) => t.name) }
      : { connected: false, tools: [] };

  return { connectObscura, disconnectObscura, getObscuraStatus };
}
