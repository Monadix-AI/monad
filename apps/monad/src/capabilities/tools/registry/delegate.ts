// Isolation is the message repo, NOT the session id: the sub-loop runs under the parent's
// sessionId so high-risk tool approvals surface on the same stream the user is watching
// (an ephemeral session id would route approvals nowhere and silently time out).

import type { Event, Hooks, SessionId } from '@monad/protocol';
import type { ContextEngine } from '@/agent/context/index.ts';
import type { ModelRouter } from '@/agent/model/index.ts';
import type { FileObservationStore, Tool, ToolBackends, ToolGate } from '@/capabilities/tools/types.ts';

import { z } from 'zod';

import { AgentLoop, InMemoryMessageRepo } from '@/agent/loop/index.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

const MAX_FORK_DEPTH = 3;

export interface SubagentRunDeps {
  model: ModelRouter;
  tools: Tool[];
  defaultModel: string;
  /** Principal id for observability span attribution, inherited from the parent. Telemetry only. */
  userId?: string;
  gate?: ToolGate;
  fileObservations?: FileObservationStore;
  maxTurns?: number;
  /** Context engine so long delegated runs compact too (same as the parent). */
  context?: ContextEngine;
  contextLimit?: number;
  /** Nesting depth — throws when >= MAX_FORK_DEPTH (3) to prevent runaway recursion. */
  forkDepth?: number;
  /** System-prompt persona for the subagent (a named agent's AGENT.md body). Absent → the loop's
   *  DEFAULT_SYSTEM_PROMPT (anonymous fork/delegate keep this undefined). */
  instructions?: string;
  /** Observe the subagent's loop events (tokens, tool calls) — `agent_delegate_to` bridges these to
   *  the parent turn's `reportProgress` so the user sees the delegated work. Absent → silent. */
  onEvent?: (event: Event) => void;
  /** Lifecycle hooks for the subagent's inner loop — so its reasoning fires BeforeModel/AfterModel
   *  (tagged `subagent` via `subagentCaller`), tool, and turn events. Absent → NO_HOOKS. */
  hooks?: Hooks;
  subagentCaller?: { agentName?: string };
}

export async function runSubagent(
  deps: SubagentRunDeps,
  task: string,
  ctx: { sessionId: string; sandboxRoots?: string[]; backends?: ToolBackends }
): Promise<string> {
  if ((deps.forkDepth ?? 0) >= MAX_FORK_DEPTH) {
    throw new Error(`fork depth limit (${MAX_FORK_DEPTH}) exceeded`);
  }
  const loop = new AgentLoop({
    model: deps.model,
    tools: deps.tools,
    messages: new InMemoryMessageRepo(), // isolated history — discarded after the run
    defaultModel: deps.defaultModel,
    userId: deps.userId,
    // Silent by default (the parent wants only the final result); `onEvent` opts into progress.
    emit: deps.onEvent ?? (() => {}),
    sandboxRoots: ctx.sandboxRoots,
    // Inherit the parent's backends so a delegated/forked subagent edits the editor's files too
    // (a delegated ACP session), instead of silently falling back to the daemon sandbox.
    backends: ctx.backends,
    fileObservations: deps.fileObservations,
    gate: deps.gate,
    maxTurns: deps.maxTurns,
    context: deps.context,
    contextLimit: deps.contextLimit,
    instructions: deps.instructions,
    hooks: deps.hooks,
    subagentCaller: deps.subagentCaller
  });
  try {
    const result = await loop.runBlock(ctx.sessionId as SessionId, task);
    return result.text;
  } finally {
    await deps.fileObservations?.clear?.(ctx.sessionId);
  }
}

export interface DelegateDeps {
  model: ModelRouter;
  /** A function is resolved per-delegation, so a hot-installed tool reaches delegated subagents too. */
  tools: Tool[] | (() => Tool[]);
  defaultModel: string;
  /** Principal id for observability span attribution, inherited from the parent. Telemetry only. */
  userId?: string;
  gate?: ToolGate;
  fileObservations?: FileObservationStore;
  maxTurns?: number;
  context?: ContextEngine;
  contextLimit?: number;
  /** Lifecycle hooks for the delegated subagent's inner loop — so its reasoning/tool/turn events fire
   *  (tagged `subagent`). Absent → NO_HOOKS, which silently bypasses any BeforeTool/ApprovalRequest
   *  policy inside delegated work. */
  hooks?: Hooks;
}

const delegateInput = z.object({
  instruction: z.string().min(1).describe('A self-contained instruction for the sub-agent to carry out')
});
type DelegateInput = z.infer<typeof delegateInput>;

export function createDelegateTool(deps: DelegateDeps): Tool<DelegateInput, { text: string }> {
  const depTools = deps.tools;
  const resolveTools: () => Tool[] = typeof depTools === 'function' ? depTools : () => depTools;

  return {
    name: 'agent_delegate',
    description:
      "Delegate a self-contained subtask to an isolated sub-agent (fresh history, same tools). Returns the sub-agent's final answer. Use to keep focused research or multi-step work out of the main context.",
    scopes: [{ resource: 'agent:delegate' }],
    inputSchema: delegateInput,
    run: async ({ instruction }, ctx) => {
      const subTools = resolveTools().filter((t) => t.name !== 'agent_delegate');
      const text = await runSubagent(
        {
          model: deps.model,
          tools: subTools,
          defaultModel: deps.defaultModel,
          userId: deps.userId,
          gate: deps.gate,
          fileObservations: deps.fileObservations,
          maxTurns: deps.maxTurns,
          context: deps.context,
          contextLimit: deps.contextLimit,
          hooks: deps.hooks,
          subagentCaller: { agentName: 'agent_delegate' }
        },
        instruction,
        ctx
      );
      return toolResult({ text });
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<DelegateDeps> = (deps) => [createDelegateTool(deps)];
