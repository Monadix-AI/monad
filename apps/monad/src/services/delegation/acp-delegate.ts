// monad as an ACP CLIENT: the `agent_acp_delegate` tool spawns a configured external ACP agent
// (claude-code-acp / codex acp / …) and drives it over stdio to carry out a self-contained subtask,
// returning its final answer. This is the mirror of the agent side (transports/acp/connection.ts):
// here monad holds the ACP client connection. Lives in apps/monad because it needs the ACP SDK.
//
// Trust + containment: only operator-vetted entries in cfg.acpAgents can be spawned (the model
// supplies a NAME, never a command — that would be RCE), and the tool is high-risk so spawning is
// gated by oversight. monad serves the sub-agent's FILESYSTEM and TERMINAL (advertised fs+terminal
// capabilities) through its OWN backends — the session's delegating backend if present (so a bridged
// editor session delegating onward routes the sub-agent's files/shell to the editor too), else a
// sandbox over the session roots — so the sub-agent's reads/writes/commands stay inside monad's
// boundary. The sub-agent's permission prompts route through monad's oversight gate, and its tool
// calls surface on the parent turn's stream via reportProgress.
//
// Multi-turn reuse: a delegation does NOT spawn-prompt-kill in one shot. The spawned adapter and its
// established ACP session are kept alive per (parent session, agent) so a follow-up delegation to the
// same agent CONTINUES the sub-agent's conversation (its context, its open files) instead of paying a
// fresh spawn + ACP handshake every turn. The persistent ClientConnection (app.connect) is held on
// the delegate; the builder handlers read a SWAPPABLE per-turn slot so one connection serves
// successive prompts. Lifecycle: evicted on the parent session's delete/reset
// (clearAcpDelegatesForSession), on adapter exit, on turn abort/failure, and after an idle timeout.

import type { McpServer } from '@agentclientprotocol/sdk';
import type { AcpAgentConfig } from '@monad/environment';
import type { Tool, ToolBackends, ToolContext, ToolGate } from '#/capabilities/tools/types.ts';
import type { Store } from '#/store/db/index.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { toolResult } from '#/capabilities/tools/types.ts';
import { setDelegateStore } from './acp-registry.ts';
import { runMeshAgent } from './acp-spawn.ts';

export { adapterSpawnEnv } from './acp-env.ts';
export { acpAuthGuidance } from './acp-errors.ts';
export { sessionMcpServersToAcp, toAcpMcpServers } from './acp-mcp.ts';
export { clearAcpDelegatesForSession } from './acp-registry.ts';

const log = createLogger('acp-delegate');

export interface AcpDelegateDeps {
  agents: AcpAgentConfig[];
  /** Oversight gate — the sub-agent's permission requests route through it. Absent → auto-allow. */
  gate?: ToolGate;
  /** monad's configured MCP servers (ACP shape) to forward so the sub-agent shares monad's tools. */
  mcpServers?: McpServer[];
  /** Persistence store — when provided, delegate lifecycle is recorded in acp_delegates. */
  store?: Store;
}

const delegateInput = z.object({
  agent: z.string().min(1).describe('Name of a configured external ACP agent to delegate to'),
  instruction: z.string().min(1).describe('A self-contained instruction for the sub-agent to carry out')
});
type DelegateInput = z.infer<typeof delegateInput>;

/** Options for a direct user→ACP agent delegation that bypasses the monad LLM layer. */
export interface DirectDelegateOpts {
  sessionId: string;
  signal?: AbortSignal;
  /** Called with each streamed text delta as the sub-agent responds. */
  onChunk?: (delta: string) => void;
  /** Called with cumulative non-answer activity such as plan and tool updates. */
  onActivity?: (activity: string) => void;
  sandboxRoots?: string[];
  backends?: ToolBackends;
  toolFilter?: (toolName: string) => boolean;
  extraTools?: Tool[];
  extraSkills?: ToolContext['extraSkills'];
  mcpServers?: McpServer[];
}

/** Send a message directly to a configured ACP agent, bypassing monad's LLM. Reuses a live session
 *  (same multi-turn reuse as agent_acp_delegate) so repeated direct calls continue the conversation. */
export async function directDelegate(spec: AcpAgentConfig, text: string, opts: DirectDelegateOpts): Promise<string> {
  const ctx: ToolContext = {
    sessionId: opts.sessionId,
    signal: opts.signal,
    sandboxRoots: opts.sandboxRoots,
    backends: opts.backends,
    toolFilter: opts.toolFilter,
    extraTools: opts.extraTools,
    extraSkills: opts.extraSkills,
    log: (level, msg, fields) => log[level]({ ...fields }, msg)
  };
  const mcpServers = spec.forwardMcp === true ? (opts.mcpServers ?? []) : [];
  return runMeshAgent(spec, text, ctx, undefined, mcpServers, opts.onChunk, opts.onActivity);
}

/** Build the `agent_acp_delegate` tool from the configured external ACP agents (enabled only). */
export function createAcpDelegateTool(deps: AcpDelegateDeps): Tool<DelegateInput, { text: string }> {
  setDelegateStore(deps.store);
  const enabled = deps.agents.filter((a) => a.enabled);
  const names = enabled.map((a) => a.name);
  return {
    name: 'agent_acp_delegate',
    description:
      'Delegate a self-contained subtask to an external ACP agent, returning its final answer. ' +
      `Available agents: ${names.join(', ')}. Use for work better handled by a specialised MeshAgent.`,
    scopes: [{ resource: 'agent:delegate' }],
    // Spawning an MeshAgent is a real escalation → route through the oversight gate once.
    highRisk: true,
    inputSchema: delegateInput,
    run: async ({ agent, instruction }, ctx) => {
      const spec = enabled.find((a) => a.name === agent);
      if (!spec) throw new Error(`unknown ACP agent "${agent}" (configured: ${names.join(', ') || 'none'})`);
      log.info({ agent }, 'delegating to external ACP agent');
      // Per-agent opt-in: only forward monad's MCP servers to agents that asked for them (forwardMcp).
      const mcpServers = spec.forwardMcp === true ? (deps.mcpServers ?? []) : [];
      const text = await runMeshAgent(spec, instruction, ctx, deps.gate, mcpServers);
      return toolResult({ text });
    }
  };
}
