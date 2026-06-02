import type { HookCaller, Hooks, SessionId } from '@monad/protocol';
import type { ModelMessage, ModelUsage } from '../../model/index.ts';
import type { AgentLoopDeps } from '../types.ts';

import { createLogger } from '@monad/logger';
import { NO_HOOKS } from '@monad/protocol';

// Times a Stop hook may force the agent to keep working in one turn before we stop honouring it —
// a backstop so a misbehaving hook can't loop forever.
const DEFAULT_MAX_STOP_CONTINUES = 2;

const log = createLogger('tool-trace');

/**
 * Hook orchestration for a turn: UserPromptSubmit/BeforeModel/AfterModel/AfterTurn wiring, plus the
 * turn-scoped state hooks contribute (model override, injected context, stop-continue count). The
 * loop is created fresh per turn, so this is turn-scoped — no cross-session/turn leakage.
 */
export class HookOrchestrator {
  // Hook-contributed state for the current turn (UserPromptSubmit): extra system context to inject
  // and an optional per-turn model override. Turn-scoped — the loop is rebuilt each turn.
  turnInjectedContext: string[] = [];
  private turnModelOverride?: string;
  // How many times a Stop hook has forced continuation this turn (bounded by maxStopContinues).
  private stopContinueCount = 0;

  constructor(private readonly deps: AgentLoopDeps) {}

  get hooks(): Hooks {
    return this.deps.hooks ?? NO_HOOKS;
  }

  /** The model used for this turn — a UserPromptSubmit hook's override, else the configured default. */
  modelId(): string {
    return this.turnModelOverride ?? this.deps.defaultModel;
  }

  /** cwd handed to command hooks — the resolved sandbox root (empty when unrestricted). */
  hookCwd(): string {
    return this.deps.sandboxRoots?.[0] ?? '';
  }

  /** Who is driving this reasoning call — main turn vs a forked subagent (for BeforeModel/AfterModel). */
  private hookCaller(): HookCaller {
    return this.deps.subagentCaller
      ? { kind: 'subagent', agentName: this.deps.subagentCaller.agentName }
      : { kind: 'main' };
  }

  /** BeforeModel: fired before each reasoning LLM request. A hook may deny (abort the turn) or rewrite
   *  the request's messages. Returns the (possibly rewritten) messages to send. */
  async beforeModel(sessionId: SessionId, messages: ModelMessage[]): Promise<ModelMessage[]> {
    const d = await this.hooks.run({
      event: 'BeforeModel',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      caller: this.hookCaller(),
      request: { model: this.modelId(), messages }
    });
    if (d.blocked) throw new Error(d.reason ?? 'model call blocked by hook');
    const req = d.effectiveRequest as { messages?: ModelMessage[] } | undefined;
    return req?.messages ?? messages;
  }

  /** AfterModel: fired after a SUCCESSFUL reasoning LLM response. A hook may rewrite the response text
   *  (e.g. redact). Returns the (possibly rewritten) text. A failed model call doesn't fire this — it
   *  ends the turn via the catch → emitError → AfterTurn(reason:'error') path. */
  async afterModel(sessionId: SessionId, text: string): Promise<string> {
    const d = await this.hooks.run({
      event: 'AfterModel',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      caller: this.hookCaller(),
      response: text
    });
    return d.effectiveText ?? text;
  }

  /**
   * Run the UserPromptSubmit hook before the turn begins: it may deny (abort), rewrite the prompt,
   * override the model, or inject context. Records override/context as turn state and returns the
   * effective prompt or a block reason.
   */
  async userPromptSubmit(
    sessionId: SessionId,
    userText: string
  ): Promise<{ blocked: true; reason: string } | { blocked: false; text: string }> {
    const d = await this.hooks.run({
      event: 'BeforeTurn',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      prompt: userText
    });
    // Apply a hook's model override only if the daemon vouches for it (a configured profile or a
    // "provider:model" spec). A bogus override is dropped so the turn falls back to the default
    // model instead of failing downstream at the gateway.
    if (d.modelOverride && (this.deps.isModelAllowed?.(d.modelOverride) ?? true)) {
      this.turnModelOverride = d.modelOverride;
    } else if (d.modelOverride) {
      // Don't silently swallow a rejected override — surface it so a misconfigured hook is debuggable.
      log.warn({ sessionId, modelOverride: d.modelOverride }, 'hook requested a disallowed model — ignored');
    }
    if (d.additionalContext.length) this.turnInjectedContext.push(...d.additionalContext);
    if (d.blocked) return { blocked: true, reason: d.reason ?? 'blocked by hook' };
    return { blocked: false, text: d.effectivePrompt ?? userText };
  }

  /**
   * Fire the Stop hook at a turn's final answer. Returns the (possibly rewritten) final text and, in
   * the agentic tool loops, a `continueReason` when a hook forces the agent to keep working — bounded
   * by `maxStopContinues` so a hook can't loop forever. Fired exactly once per final-answer decision.
   */
  async runStopHook(
    sessionId: SessionId,
    text: string,
    usage?: ModelUsage,
    reason: 'completed' | 'aborted' = 'completed'
  ): Promise<{ text: string; continueReason?: string }> {
    const d = await this.hooks.run({
      event: 'AfterTurn',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      reason,
      ok: reason === 'completed',
      response: text,
      usage
    });
    const finalText = d.effectiveText ?? text;
    const max = this.deps.maxStopContinues ?? DEFAULT_MAX_STOP_CONTINUES;
    if (d.continueWork && this.stopContinueCount < max) {
      this.stopContinueCount++;
      return { text: finalText, continueReason: d.continueWork.reason };
    }
    return { text: finalText };
  }
}
