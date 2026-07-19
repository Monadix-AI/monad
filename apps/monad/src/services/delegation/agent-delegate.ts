// monad-to-monad delegation: the `agent_delegate_to` tool runs one of the operator's Studio agents
// (those flagged `visibility.subagentCallable`) as an in-process subagent — under its OWN AGENT.md
// persona and its OWN narrowed tool set — and returns its final answer. This is the peer/in-process
// model, distinct from `agent_acp_delegate` (external ACP process) and the anonymous
// `agent_delegate` fork (same tools, no persona).
//
// Security (containment, never escalation):
//   - The model supplies a NAME, never a command; only roster entries are runnable.
//   - The subagent's tools = parent's available tools ∩ the target's atoms allow/deny — a per-agent
//     allowlist only SUBTRACTS, it can never grant a tool/scope the parent lacks (`isToolExposed`).
//   - Delegate/skill-manage tools are excluded from the subagent set, so a delegated agent cannot
//     delegate onward — A→B→A recursion is structurally impossible (matches the fork path).
//   - The subagent runs under the PARENT sessionId (runSubagent), so its high-risk approvals surface
//     on the same oversight stream the user is watching.

import type { Event } from '@monad/protocol';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { DelegatableAgent } from '#/services/generation/agent-persona.ts';

import { createLogger } from '@monad/logger';
import { parseEventPayload } from '@monad/protocol';
import { z } from 'zod';

import { runSubagent } from '#/capabilities/tools/registry/delegate.ts';
import { toolResult } from '#/capabilities/tools/types.ts';
import { isToolExposed } from '#/services/generation/agent-persona.ts';

const log = createLogger('agent-delegate');

/** Tools a subagent must never receive — they would let it delegate onward or rewrite skills. */
const EXCLUDED_SUBAGENT_TOOLS = new Set(['agent_delegate', 'agent_delegate_to', 'agent_acp_delegate', 'skill_manage']);

/** The runSubagent deps we forward verbatim — derived from its signature to avoid re-importing the
 *  ModelRouter/ContextEngine types (which would couple this file to agent-core internals). */
type SubagentDeps = Parameters<typeof runSubagent>[0];

export interface AgentDelegateDeps {
  /** Live roster of delegatable agents (resolved at call time, so a newly-added agent is reachable). */
  agents: () => DelegatableAgent[];
  /** The parent's live base tools — the ceiling the subagent's set is narrowed within. */
  tools: () => Tool[];
  /** Resolve a tool's atom-pack/MCP source name (the registry's `sourceNameOf`); built-ins → undefined. */
  toolSource: (toolName: string) => string | undefined;
  model: SubagentDeps['model'];
  defaultModel: string;
  gate?: SubagentDeps['gate'];
  fileObservations?: SubagentDeps['fileObservations'];
  context?: SubagentDeps['context'];
  contextLimit?: number;
  /** Lifecycle hooks for the delegated agent's inner loop — so its reasoning/tool/turn events fire
   *  (tagged `subagent`). Absent → NO_HOOKS, bypassing any BeforeTool/ApprovalRequest policy. */
  hooks?: SubagentDeps['hooks'];
}

const delegateInput = z.object({
  agent: z.string().min(1).describe('Name of one of the available specialist agents to delegate to'),
  instruction: z.string().min(1).describe('A self-contained instruction for the sub-agent to carry out')
});
type DelegateInput = z.infer<typeof delegateInput>;

/** Build the `agent_delegate_to` tool. Description enumerates the boot roster (with each agent's
 *  when-to-use `description`); the target is re-resolved live at call time. */
export function createAgentDelegateTool(deps: AgentDelegateDeps): Tool<DelegateInput, { text: string }> {
  const roster = deps.agents();
  const lines = roster.map((a) => `- ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');
  return {
    name: 'agent_delegate_to',
    description:
      'Delegate a self-contained subtask to one of your configured specialist agents. The agent runs ' +
      'with its own persona and a tool set narrowed to its allowlist, then returns its final answer.\n' +
      `Available agents:\n${lines}`,
    scopes: [{ resource: 'agent:delegate' }],
    inputSchema: delegateInput,
    run: async ({ agent, instruction }, ctx) => {
      const names = deps.agents().map((a) => a.name);
      const target = deps.agents().find((a) => a.name === agent);
      if (!target) throw new Error(`unknown agent "${agent}" (delegatable: ${names.join(', ') || 'none'})`);

      // exposure ⊆ registration: start from the parent's tools (minus delegate/skill-manage) and keep
      // only those the target's atoms policy admits. Built-ins (no source) stay ungated.
      const subTools = deps
        .tools()
        .filter((t) => !EXCLUDED_SUBAGENT_TOOLS.has(t.name))
        .filter((t) => isToolExposed(target.atoms, t.name, deps.toolSource(t.name)));

      log.info({ agent, tools: subTools.length }, 'delegating to studio agent');
      // Bridge the subagent's activity (streamed text + tool calls) onto the parent turn's stream so
      // the user sees what the delegated agent is doing, not just its final answer (mirrors acp-delegate).
      let activity = `▸ ${target.name}\n`;
      const onEvent = (e: Event): void => {
        switch (e.type) {
          case 'session.message.delta.appended': {
            const payload = parseEventPayload('session.message.delta.appended', e.payload);
            if (payload.channel !== 'reasoning') activity += payload.delta;
            break;
          }
          case 'tool.called':
            activity += `\n  ↪ ${(e.payload as { tool?: string }).tool ?? ''}`;
            break;
          case 'tool.result':
            activity += (e.payload as { ok?: boolean }).ok === false ? ' [failed]' : ' [ok]';
            break;
          default:
            return; // ignore other events (don't spam reportProgress)
        }
        ctx.reportProgress?.(activity);
      };
      const text = await runSubagent(
        {
          model: deps.model,
          tools: subTools,
          defaultModel: target.model ?? deps.defaultModel,
          gate: deps.gate,
          fileObservations: deps.fileObservations,
          context: deps.context,
          contextLimit: deps.contextLimit,
          instructions: target.instructions,
          forkDepth: 1,
          onEvent,
          hooks: deps.hooks,
          subagentCaller: { agentName: agent }
        },
        instruction,
        ctx
      );
      return toolResult({ text });
    }
  };
}

import type { ToolModule } from '#/capabilities/tools/registry/contract.ts';
// Uniform module entry.
export const register: ToolModule<AgentDelegateDeps> = (deps) => [createAgentDelegateTool(deps)];
