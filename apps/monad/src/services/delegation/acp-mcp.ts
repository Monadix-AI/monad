import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerConfig, MonadAuth } from '@monad/home';
import type { SessionMcpServer } from '@monad/protocol';

import { createLogger } from '@monad/logger';

import { mcpHttpHeaders } from '#/bootstrap/mcp.ts';
import { resolveSecretMap } from '#/config/secrets.ts';

const log = createLogger('acp-delegate');

const toPairs = (m: Record<string, string>): { name: string; value: string }[] =>
  Object.entries(m).map(([name, value]) => ({ name, value }));

/**
 * Map monad's configured MCP servers into the ACP `newSession` shape so a delegated sub-agent shares
 * monad's external tools. PER-SERVER ISOLATED: a server whose secret refs (${env:}/${secret:}) fail to
 * resolve, or an oauth-mode http server (its bearer is refreshed dynamically and can't be forwarded as
 * a static header), is SKIPPED and logged — one bad server never aborts the whole set (mirrors how
 * bootstrap/mcp.ts isolates each server). Reuses bootstrap's mcpHttpHeaders so http auth stays in sync.
 *
 * Caveats by design: forwarding hands RESOLVED secrets to third-party adapter code and makes the
 * adapter spawn its OWN second copy of each stdio server (a stateful server — single write-lock DB,
 * exclusive port, singleton browser — may conflict with monad's instance). That's why it's gated per
 * agent by `forwardMcp` (default off). http servers are additionally filtered at delegation time to
 * adapters that advertise mcp http capability (see spawnDelegate). Browser/computer PRESET MCP
 * servers are intentionally NOT forwarded — they grant host control and are not "shared tools".
 * Exported for testing.
 */
export function toAcpMcpServers(servers: McpServerConfig[], auth?: MonadAuth): McpServer[] {
  const out: McpServer[] = [];
  for (const s of servers) {
    if (!s.enabled) continue;
    if (s.transport === 'http' && s.auth.mode === 'oauth') {
      log.debug({ server: s.name }, 'not forwarding oauth MCP server (dynamic bearer not forwardable)');
      continue;
    }
    try {
      if (s.transport === 'stdio') {
        out.push({
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: toPairs(resolveSecretMap(s.env, auth) ?? {})
        });
      } else {
        out.push({ name: s.name, type: 'http', url: s.url, headers: toPairs(mcpHttpHeaders(s, auth)) });
      }
    } catch (err) {
      log.warn({ server: s.name, err: String(err) }, 'not forwarding MCP server (unresolved secret)');
    }
  }
  return out;
}

export function sessionMcpServersToAcp(servers: SessionMcpServer[]): McpServer[] {
  return servers.map((s) => {
    if (s.transport === 'http') {
      return {
        name: s.name,
        type: 'http',
        url: s.url,
        headers: toPairs(s.headers ?? {})
      };
    }
    return {
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: toPairs(s.env ?? {})
    };
  });
}
