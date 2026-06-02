import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerSpec } from '#/capabilities/tools';

/** Extension methods advertised in `initialize` under `_meta.monad.extMethods`. */
export const MONAD_EXT_METHODS = [
  '_monad/session.restore',
  '_monad/model.listProviders',
  '_monad/model.listModels',
  '_monad/model.listProfiles',
  '_monad/model.getDefaultProfile',
  '_monad/model.setDefaultProfile'
] as const;

/** Map an ACP MCP server descriptor to monad's connect spec. Returns null for transports monad's
 * MCP client doesn't speak (sse, acp). Structural checks tolerate tag-shape variations across SDK
 * versions (stdio carries `command`; http carries a `url`). */
export function toMcpSpec(server: McpServer): McpServerSpec | null {
  if ('command' in server) {
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]))
    };
  }
  if ('type' in server && server.type === 'http' && 'url' in server) {
    return {
      name: server.name,
      transport: 'http',
      url: server.url,
      headers: Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]))
    };
  }
  return null;
}

/** Read monad's namespaced metadata bag off any ACP `_meta` field. */
export function monadMeta(meta: unknown): { agentId?: string } | undefined {
  if (meta && typeof meta === 'object' && 'monad' in meta) {
    return (meta as { monad?: { agentId?: string } }).monad;
  }
  return undefined;
}
