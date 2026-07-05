import type { ClientConnection } from '@agentclientprotocol/sdk';
import type { AcpAgentConfig } from '@monad/home';
import type { sandboxedSpawn } from '@/capabilities/tools';
import type { TerminalExecResult, ToolBackends, ToolContext, ToolGate } from '@/capabilities/tools/types.ts';

// ── Reusable live delegates ──────────────────────────────────────────────────────────────────────
// The builder handlers below are registered ONCE per delegate but must serve whichever turn is
// currently running, so the per-turn state — the caller's ctx/gate/backends plus the result/activity
// accumulators — lives in a swappable `turn` slot rather than being captured as call-locals.

// ACP terminals are handle-based (create → poll output / wait exit / kill / release); monad's terminal
// backend is a single exec. Bridge by running exec in the background and tracking state.
export interface Term {
  output: string;
  result: TerminalExecResult | null;
  done: Promise<TerminalExecResult | null>;
  abort: AbortController;
}

// Per-turn state the long-lived builder handlers read. `result` = the sub-agent's answer (returned to
// the model); `activity` = a live log that ALSO surfaces the sub-agent's tool calls, reported via
// ctx.reportProgress so the user sees what the delegated agent is doing on the parent turn's stream.
interface DelegateTurn {
  ctx: ToolContext;
  gate: ToolGate | undefined;
  backends: ToolBackends;
  result: string;
  activity: string;
  processActivity: string;
  onChunk?: (delta: string) => void;
  onActivity?: (activity: string) => void;
}

export interface LiveDelegate {
  spec: AcpAgentConfig;
  proc: ReturnType<typeof sandboxedSpawn>;
  conn: ClientConnection;
  acpSessionId: string;
  terminals: Map<string, Term>;
  termSeq: number;
  turn: DelegateTurn | null; // set for the duration of a prompt; null between turns
  idleTimer: ReturnType<typeof setTimeout> | null;
  queue: Promise<unknown>; // serializes prompts to this delegate (parallel tool calls share one session)
  // Counters kept in sync with the persisted row so touchAcpDelegate can write the current values.
  reuseCount: number; // incremented on each successful getOrSpawn that found an existing delegate
  promptCount: number; // incremented after each successful session/prompt
}
