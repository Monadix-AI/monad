import type { A2aAgentStatus, Agent } from '@monad/protocol';

import { a2aAgentCardPath, a2aJsonRpcPath } from '@monad/protocol';

/** Origin the caller reached us on, so advertised URLs actually route back. Honours a reverse
 *  proxy's `x-forwarded-proto`; falls back to loopback http. */
export function baseUrlOf(request: Request): string {
  const host = request.headers.get('host') ?? '127.0.0.1';
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

/** The A2A exposure status for one agent — its enablement plus the canonical card/JSON-RPC URLs
 *  for the daemon's current bind, ready for a management client to render or copy. */
export function buildA2aStatus(agent: Agent, baseUrl: string): A2aAgentStatus {
  return {
    agentId: agent.id,
    enabled: agent.a2a?.enabled ?? false,
    agentCardUrl: `${baseUrl}${a2aAgentCardPath(agent.id)}`,
    jsonRpcUrl: `${baseUrl}${a2aJsonRpcPath(agent.id)}`
  };
}
