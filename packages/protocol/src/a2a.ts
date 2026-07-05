import { z } from 'zod';

/** URL path segments for the per-agent A2A surface. The daemon mounts the AgentCard and the
 *  JSON-RPC endpoint under these paths, and the UI/status endpoint construct their URLs from the
 *  same helpers so the two never drift. `agentId` is the `agt_`-prefixed id. */
export const a2aJsonRpcPath = (agentId: string): string => `/a2a/agents/${agentId}`;
export const a2aAgentCardPath = (agentId: string): string => `/a2a/agents/${agentId}/.well-known/agent-card.json`;

/** A2A exposure status for one agent, surfaced to management clients (the web Studio). The URLs
 *  are absolute and canonical for the daemon's current bind, so a client renders/copies them
 *  without reconstructing paths. `enabled: false` still returns the URLs the agent *would* serve
 *  at, so the UI can preview them next to the toggle. */
export const a2aAgentStatusSchema = z.object({
  agentId: z.string(),
  enabled: z.boolean(),
  agentCardUrl: z.string(),
  jsonRpcUrl: z.string()
});
export type A2aAgentStatus = z.infer<typeof a2aAgentStatusSchema>;

export const getA2aAgentStatusResponseSchema = z.object({ status: a2aAgentStatusSchema });
export type GetA2aAgentStatusResponse = z.infer<typeof getA2aAgentStatusResponseSchema>;
