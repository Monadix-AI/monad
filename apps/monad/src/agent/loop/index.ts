import type {
  AgentMessagePayload,
  AgentReasoningPayload,
  Cost,
  Event,
  EventType,
  HookCaller,
  Hooks,
  TranscriptTargetId
} from '@monad/protocol';
import type { Tool, ToolGate } from '@/capabilities/tools/types.ts';
import type { ModelMessage, ModelUsage, ToolCall, ToolSpec } from '../model/index.ts';
import type { PersistedModelInputOverride } from './replay.ts';
import type { AgentLoopDeps, ChatMessage, ImageAttachment, LoadedSkill } from './types.ts';

import { createLogger } from '@monad/logger';
import { finishReasonSchema, NO_HOOKS, newId, parseSlashCommand } from '@monad/protocol';

import { computeCost } from '../model/cost.ts';
import { BUDGET_EXCEEDED, TOOL_BUDGET_REACHED } from '../prompts.ts';
import { extractError } from './extract-error.ts';
import { PromptBuilder } from './prompt-builder.ts';
import { parseAllowedTools, renderSkillBody, toolMatchesAllowedPattern } from './skill-render.ts';
import { ToolExecutor } from './tool-execution.ts';

export type {
  AgentLoopDeps,
  ChatMessage,
  ImageAttachment,
  LoadedSkill,
  MessageRepo,
  SkillTier,
  ToolSearchConfig
} from './types.ts';

export { extractError } from './extract-error.ts';
export { InMemoryMessageRepo } from './memory-repo.ts';
export { PromptReplayCache, replayHistory } from './replay.ts';
export {
  parseAllowedTools,
  renderShellInjections,
  renderSkillBody,
  substituteSkillDir,
  toolMatchesAllowedPattern
} from './skill-render.ts';

// Model⇄tool round-trips allowed per turn before forcing a direct answer. Absent → unlimited.

// Times a Stop hook may force the agent to keep working in one turn before we stop honouring it —
// a backstop so a misbehaving hook can't loop forever.
const DEFAULT_MAX_STOP_CONTINUES = 2;

const log = createLogger('tool-trace');

export class AgentLoop {
  // Tool patterns pre-approved by skills active this turn (allowed-tools). The loop is
  // created fresh per turn, so this is turn-scoped — no cross-session/turn leakage.
  private readonly grantedToolPatterns = new Set<string>();

  // Hook-contributed state for the current turn (UserPromptSubmit): extra system context to inject
  // and an optional per-turn model override. Turn-scoped — the loop is rebuilt each turn.
  private turnInjectedContext: string[] = [];
  private turnModelOverride?: string;
  // How many times a Stop hook has forced continuation this turn (bounded by maxStopContinues).
  private stopContinueCount = 0;

  // History replay, system-prompt rendering, tool-spec caching, and context-window bookkeeping.
  private readonly prompt: PromptBuilder;

  // Gate/hook orchestration around invokeTool, result truncation, and tool round-trip persistence.
  private readonly toolExecutor: ToolExecutor;

  constructor(private readonly deps: AgentLoopDeps) {
    this.prompt = new PromptBuilder(
      deps,
      () => this.availableTools,
      () => this.modelId(),
      (sessionId, type, payload) => this.deps.emit(this.event(sessionId, type, payload))
    );
    this.toolExecutor = new ToolExecutor(
      deps,
      () => this.availableTools,
      () => this.hooks,
      () => this.hookCwd(),
      () => this.effectiveGate(),
      (sessionId, type, payload) => this.deps.emit(this.event(sessionId, type, payload)),
      (context) => this.turnInjectedContext.push(...context),
      (name) => this.activateSkill(name)
    );
  }

  private get hooks(): Hooks {
    return this.deps.hooks ?? NO_HOOKS;
  }

  /** The model used for this turn — a UserPromptSubmit hook's override, else the configured default. */
  private modelId(): string {
    return this.turnModelOverride ?? this.deps.defaultModel;
  }

  /** cwd handed to command hooks — the resolved sandbox root (empty when unrestricted). */
  private hookCwd(): string {
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
  private async beforeModel(sessionId: TranscriptTargetId, messages: ModelMessage[]): Promise<ModelMessage[]> {
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
  private async afterModel(sessionId: TranscriptTargetId, text: string): Promise<string> {
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
  private async userPromptSubmit(
    sessionId: TranscriptTargetId,
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

  /** Tools usable this run: the agent's base tools plus any per-run `extraTools` (e.g. an ACP
   * session's client-provided MCP tools), minus those a `toolFilter` removes (e.g. an ACP-delegated
   * session dropping daemon-host tools). Filtering drops both model-facing specs and executability. */
  private get availableTools(): Tool[] {
    const all = this.deps.extraTools?.length ? [...this.deps.tools, ...this.deps.extraTools] : this.deps.tools;
    const filter = this.deps.toolFilter;
    return filter ? all.filter((t) => filter(t.name)) : all;
  }

  /** Compute USD cost for a single model step. Uses injected computeCost or the static fallback. */
  private stepCost(usage: ModelUsage | undefined): Cost {
    const cc = this.deps.computeCost ?? computeCost;
    return cc(usage, undefined, usage?.costUsd);
  }

  private activateSkill(name: string): void {
    const skill = (this.deps.skills ?? []).find((s) => s.name === name);
    if (skill?.allowedTools) for (const p of parseAllowedTools(skill.allowedTools)) this.grantedToolPatterns.add(p);
  }

  private isToolGranted(toolName: string): boolean {
    for (const pattern of this.grantedToolPatterns) {
      if (toolMatchesAllowedPattern(pattern, toolName)) return true;
    }
    return false;
  }

  /**
   * The gate handed to invokeTool. When no skill has granted anything, it's the underlying
   * gate unchanged (so existing fail-closed behaviour is preserved). Once an active skill
   * grants a tool, that tool is auto-approved; everything else still defers to the gate.
   */
  private gateWrapper?: ToolGate;
  private effectiveGate(): ToolGate | undefined {
    // Build the wrapper once and reuse it across tool calls (grantedToolPatterns is read live inside
    // isToolGranted, so memoizing doesn't stale the grant set; deps.gate is stable for this loop).
    // Always wrap so ApprovalRequest fires whenever a tool actually reaches the gate (high-risk or
    // hook-forced). A hook may auto-deny or auto-approve; `ask`/no-decision defers to the human gate.
    // (ApprovalRequest with no configured hooks takes the runner's zero-allocation fast path.)
    if (!this.gateWrapper) {
      this.gateWrapper = async (request) => {
        if (this.isToolGranted(request.tool)) return { allow: true };
        const d = await this.hooks.run({
          event: 'ApprovalRequest',
          sessionId: request.sessionId as TranscriptTargetId,
          cwd: this.hookCwd(),
          timestamp: new Date().toISOString(),
          toolName: request.tool,
          toolInput: request.input
        });
        if (d.blocked) return { allow: false, reason: d.reason ?? 'denied by approval hook' };
        if (d.allowed && !d.ask) return { allow: true };
        if (this.deps.gate) return this.deps.gate(request);
        return { allow: false, reason: 'high-risk tool requires an approval gate but none is configured' };
      };
    }
    return this.gateWrapper;
  }

  async runStream(
    sessionId: TranscriptTargetId,
    userText: string,
    signal?: AbortSignal,
    attachments?: ImageAttachment[]
  ): Promise<void> {
    this.prompt.setAttachments(attachments);
    this.prompt.resetSkillExpansion();
    const submit = await this.userPromptSubmit(sessionId, userText);
    if (submit.blocked) {
      // Persist the user's (raw) prompt before the policy reply so the transcript shows what was
      // denied — a denied turn still has a user bubble, not an orphan assistant message.
      const messageId = await this.beginTurn(sessionId, userText);
      await this.finishTurn(sessionId, messageId, submit.reason);
      return;
    }
    userText = submit.text;
    // Explicit `/name` of a `context: fork` skill → run it as an isolated subagent and emit
    // only its result (consistent with the model auto-loading a fork skill).
    const ex = this.resolveExplicitSkill(userText);
    if (ex?.skill.fork && this.deps.runFork) {
      const messageId = await this.beginTurn(sessionId, userText);
      this.activateSkill(ex.skill.name);
      try {
        const result = await this.deps.runFork(
          renderSkillBody(ex.skill.body, ex.argString, ex.skill.dir),
          { sessionId, sandboxRoots: this.deps.sandboxRoots, backends: this.deps.backends },
          ex.skill.tier,
          ex.skill.name
        );
        this.deps.emit(this.event(sessionId, 'agent.token', { messageId, delta: result, index: 0 }));
        await this.finishTurn(sessionId, messageId, result);
      } catch (err) {
        await this.emitError(sessionId, messageId, err);
        throw err;
      }
      return;
    }

    const modelInput = ex ? this.skillModelInput(ex.skill.name, this.applyNonForkSkill(ex)) : undefined;
    const messageId = await this.beginTurn(sessionId, userText, modelInput);

    try {
      if (this.availableTools.length > 0) {
        await this.runStreamWithTools(sessionId, messageId, signal);
        return;
      }

      const messages = await this.prompt.prepare(sessionId, await this.prompt.buildPrompt(sessionId));
      const seg = this.beginSegment(sessionId, messageId, 0);
      let text = '';
      let reasoning = '';
      let usage: ModelUsage | undefined;
      for await (const chunk of this.deps.model.stream({
        model: this.modelId(),
        messages: await this.beforeModel(sessionId, messages),
        sessionId,
        userId: this.deps.userId
      })) {
        if (signal?.aborted) break; // sessions.abort — stop consuming; persist what we have
        if (!chunk) continue; // defensive: a provider may yield an empty pull before the next real chunk
        if (chunk.type === 'usage') {
          usage = chunk.usage;
          continue;
        }
        if (chunk.type === 'reasoning') {
          reasoning += chunk.token;
          seg.emitReasoning(chunk.token);
          continue;
        }
        if (chunk.type !== 'text') continue;
        text += chunk.token;
        seg.emitToken(chunk.token);
      }

      this.prompt.noteUsage(usage);
      // AfterModel fires immediately after each model call (here the single streamed response).
      text = await this.afterModel(sessionId, text);
      if (!(await seg.settle(text, reasoning))) await this.appendEmptyAnswer(sessionId, messageId);
      // No tool loop here, so a Stop hook can only observe + rewrite the final text (no continuation).
      const stop = await this.runStopHook(sessionId, text, usage, signal?.aborted ? 'aborted' : 'completed');
      if (stop.text !== text) await this.repersistFinalText(sessionId, messageId, stop.text);
      await this.finishBookkeeping(sessionId, messageId, stop.text, usage);
    } catch (err) {
      await this.emitError(sessionId, messageId, err);
      throw err;
    }
  }

  async runBlock(
    sessionId: TranscriptTargetId,
    userText: string,
    attachments?: ImageAttachment[]
  ): Promise<ChatMessage> {
    this.prompt.setAttachments(attachments);
    this.prompt.resetSkillExpansion();
    const submit = await this.userPromptSubmit(sessionId, userText);
    if (submit.blocked) {
      const messageId = await this.beginTurn(sessionId, userText);
      return this.finishTurn(sessionId, messageId, submit.reason);
    }
    userText = submit.text;
    // Explicit `/name` of a `context: fork` skill → run it as an isolated subagent, returning
    // only its result.
    const ex = this.resolveExplicitSkill(userText);
    if (ex?.skill.fork && this.deps.runFork) {
      const messageId = await this.beginTurn(sessionId, userText);
      this.activateSkill(ex.skill.name);
      try {
        const result = await this.deps.runFork(
          renderSkillBody(ex.skill.body, ex.argString, ex.skill.dir),
          { sessionId, sandboxRoots: this.deps.sandboxRoots, backends: this.deps.backends },
          ex.skill.tier,
          ex.skill.name
        );
        return this.finishTurn(sessionId, messageId, result);
      } catch (err) {
        await this.emitError(sessionId, messageId, err);
        throw err;
      }
    }

    const modelInput = ex ? this.skillModelInput(ex.skill.name, this.applyNonForkSkill(ex)) : undefined;
    const messageId = await this.beginTurn(sessionId, userText, modelInput);

    try {
      if (this.availableTools.length > 0) {
        const { text, usage } = await this.runToolLoop(sessionId);
        return this.finishTurn(sessionId, messageId, text, usage);
      }

      const messages = await this.prompt.prepare(sessionId, await this.prompt.buildPrompt(sessionId));
      const result = await this.deps.model.complete({
        model: this.modelId(),
        messages: await this.beforeModel(sessionId, messages),
        sessionId,
        userId: this.deps.userId
      });
      const parsed = finishReasonSchema.safeParse(result.finishReason);
      this.prompt.noteUsage(result.usage);
      const responseText = await this.afterModel(sessionId, result.text);
      const stop = await this.runStopHook(sessionId, responseText, result.usage);
      return this.finishTurn(sessionId, messageId, stop.text, result.usage, parsed.success ? parsed.data : undefined);
    } catch (err) {
      await this.emitError(sessionId, messageId, err);
      throw err;
    }
  }

  // Prompt assembly (history replay, system prompt, tool-spec caching, context-window bookkeeping)
  // lives in PromptBuilder — see its constructor call in AgentLoop's constructor.

  /**
   * Block tool loop: prompt the model with the tool set; while it returns tool-calls, execute
   * them (gate + sandbox via invokeTool), feed structured tool results back, and re-prompt —
   * up to a step budget. Returns the model's final prose.
   */
  private async runToolLoop(sessionId: TranscriptTargetId): Promise<{ text: string; usage?: ModelUsage }> {
    const maxTurns = this.deps.maxTurns;
    const maxBudgetUsd = this.deps.maxBudgetUsd;
    let messages = await this.prompt.buildPrompt(sessionId, true, this.turnInjectedContext);
    const tools = this.prompt.toolSpecs();
    let step = 0;
    let accumulatedCostUsd = 0;

    const stepLimit = maxTurns ?? Number.MAX_SAFE_INTEGER;
    const budgetExceeded = (): boolean => {
      if (!maxBudgetUsd) return false;
      return accumulatedCostUsd > maxBudgetUsd;
    };

    for (; step < stepLimit && !budgetExceeded(); step++) {
      messages = await this.prompt.prepare(sessionId, messages); // re-bound each step: tool round-trips grow it
      const result = await this.deps.model.complete({
        model: this.modelId(),
        messages: await this.beforeModel(sessionId, messages),
        tools,
        sessionId,
        userId: this.deps.userId
      });
      this.prompt.noteUsage(result.usage);
      // AfterModel fires per model step — including the intermediate responses that carry tool calls.
      const responseText = await this.afterModel(sessionId, result.text);

      // Accumulate USD cost from this step when a budget is set.
      if (maxBudgetUsd && result.usage) {
        const sc = this.stepCost(result.usage);
        if (sc?.usd) accumulatedCostUsd += sc.usd;
      }

      const allCalls = result.toolCalls ?? [];
      const clientCalls = allCalls.filter((c) => !c.providerExecuted);
      const providerCalls = allCalls.filter((c) => c.providerExecuted);

      // Persist provider-executed calls (e.g. Anthropic/OpenAI native web_search) for UI
      // visibility and next-turn context. No local execution — the provider already resolved them.
      for (const call of providerCalls) {
        await this.toolExecutor.persistToolStep(sessionId, call, '', true);
      }

      if (!clientCalls.length) {
        // Candidate final answer — a Stop hook may force the agent to keep working.
        const stop = await this.runStopHook(sessionId, responseText, result.usage);
        if (stop.continueReason) {
          messages.push({ role: 'assistant', content: responseText });
          messages.push({ role: 'user', content: stop.continueReason });
          continue;
        }
        return { text: stop.text, usage: result.usage };
      }
      await this.toolExecutor.runToolCalls(sessionId, responseText, clientCalls, messages);
    }

    // Budget exhausted (turn limit or cost) — force a direct answer with no tools offered.
    const budgetMsg = budgetExceeded() ? BUDGET_EXCEEDED : TOOL_BUDGET_REACHED;
    messages.push({ role: 'user', content: budgetMsg });
    const result = await this.deps.model.complete({
      model: this.modelId(),
      messages: await this.beforeModel(sessionId, messages),
      sessionId,
      userId: this.deps.userId
    });
    const stop = await this.runStopHook(sessionId, await this.afterModel(sessionId, result.text), result.usage);
    return { text: stop.text, usage: result.usage };
  } // budget-exhausted single answer — afterModel + runStopHook fire once on this final response

  /**
   * Streaming tool loop. Each step streams a model turn natively: text deltas stream live as
   * `agent.token`, tool-call parts are collected. While a step yields tool-calls, execute them
   * (gate + sandbox via invokeTool), feed structured results back, and re-prompt — up to a step
   * budget. The first step with no tool-calls is the final answer. runStream uses this when
   * tools are registered.
   */
  private async runStreamWithTools(
    sessionId: TranscriptTargetId,
    messageId: `msg_${string}`,
    signal?: AbortSignal
  ): Promise<void> {
    const maxTurns = this.deps.maxTurns;
    const maxBudgetUsd = this.deps.maxBudgetUsd;
    let messages = await this.prompt.buildPrompt(sessionId, true, this.turnInjectedContext);
    const tools = this.prompt.toolSpecs();
    let segmentId = messageId; // the first text segment reuses the id beginTurn allocated
    let reasonBase = 0;
    let lastUsage: ModelUsage | undefined;
    let step = 0;
    let accumulatedCostUsd = 0;

    const stepLimit = maxTurns ?? Number.MAX_SAFE_INTEGER;
    const budgetExceeded = (): boolean => {
      if (!maxBudgetUsd) return false;
      return accumulatedCostUsd > maxBudgetUsd;
    };

    for (; step < stepLimit && !budgetExceeded(); step++) {
      messages = await this.prompt.prepare(sessionId, messages); // re-bound each step: tool round-trips grow it
      const seg = this.beginSegment(sessionId, segmentId, reasonBase);
      const { text, reasoning, calls, providerExecuted, usage } = await this.streamStep(
        messages,
        tools,
        seg.emitToken,
        seg.emitReasoning,
        signal,
        sessionId
      );
      reasonBase = seg.reasonIndex();
      if (usage) lastUsage = usage;
      this.prompt.noteUsage(usage);
      // Accumulate USD cost from this step when a budget is set.
      if (maxBudgetUsd && usage) {
        const sc = this.stepCost(usage);
        if (sc?.usd) accumulatedCostUsd += sc.usd;
      }
      const isFinal = signal?.aborted || calls.length === 0;
      // Settle this step's text as its own row, BEFORE its tool rows are appended — so the turn's
      // text↔tool sequence persists in order instead of one flattened assistant row.
      const wrote = await seg.settle(text, reasoning);

      // Persist provider-executed steps (e.g. Anthropic/OpenAI native web_search) for UI
      // visibility. No local execution — the provider already resolved them.
      for (const { call, output } of providerExecuted) {
        this.deps.emit(
          this.event(sessionId, 'tool.called', { toolCallId: call.toolCallId, tool: call.toolName, input: call.input })
        );
        this.deps.emit(
          this.event(sessionId, 'tool.result', {
            toolCallId: call.toolCallId,
            tool: call.toolName,
            ok: true,
            result: output
          })
        );
        await this.toolExecutor.persistToolStep(sessionId, call, output, true);
      }

      if (isFinal) {
        // Candidate final answer — a Stop hook may force the agent to keep working. (AfterModel
        // already fired inside streamStep, so `text` is the post-AfterModel response here.)
        const stop = await this.runStopHook(sessionId, text, lastUsage, signal?.aborted ? 'aborted' : 'completed');
        if (stop.continueReason) {
          // Record this (already-settled) answer in the model context, inject the continue
          // instruction, and re-enter with a fresh segment.
          messages.push({ role: 'assistant', content: text || '(continuing)' });
          messages.push({ role: 'user', content: stop.continueReason });
          segmentId = newId('msg');
          continue;
        }
        // The final step IS the answer. Ensure an assistant row exists even for an empty answer.
        if (!wrote) await this.appendEmptyAnswer(sessionId, segmentId);
        if (stop.text !== text) await this.repersistFinalText(sessionId, segmentId, stop.text);
        await this.finishBookkeeping(sessionId, segmentId, stop.text, lastUsage);
        return;
      }
      await this.toolExecutor.runToolCalls(sessionId, text, calls, messages, signal);
      segmentId = newId('msg'); // the next step's text is a fresh, later-sorting segment
    }

    // Budget exhausted (turn limit or cost) — stream a direct answer with no tools offered.
    const budgetMsg = budgetExceeded() ? BUDGET_EXCEEDED : TOOL_BUDGET_REACHED;
    messages.push({ role: 'user', content: budgetMsg });
    const seg = this.beginSegment(sessionId, segmentId, reasonBase);
    let finalText = '';
    let finalUsage: ModelUsage | undefined;
    for await (const chunk of this.deps.model.stream({
      model: this.modelId(),
      messages: await this.beforeModel(sessionId, messages),
      sessionId,
      userId: this.deps.userId
    })) {
      if (signal?.aborted) break;
      if (!chunk) continue; // defensive: a provider may yield an empty pull before the next real chunk
      if (chunk.type === 'usage') {
        finalUsage = chunk.usage;
        continue;
      }
      if (chunk.type !== 'text') continue;
      finalText += chunk.token;
      seg.emitToken(chunk.token);
    }
    if (!(await seg.settle(finalText))) await this.appendEmptyAnswer(sessionId, segmentId);
    const stop = await this.runStopHook(
      sessionId,
      await this.afterModel(sessionId, finalText),
      finalUsage ?? lastUsage,
      signal?.aborted ? 'aborted' : 'completed'
    );
    if (stop.text !== finalText) await this.repersistFinalText(sessionId, segmentId, stop.text);
    await this.finishBookkeeping(sessionId, segmentId, stop.text, finalUsage ?? lastUsage);
  }

  /** Persist an empty assistant row so a turn that ended with no closing text still has an answer
   * message (the UI anchors the turn on it). Excluded from context — an empty assistant turn must
   * not reach the next prompt (some providers reject empty assistant content). */
  private async appendEmptyAnswer(sessionId: TranscriptTargetId, messageId: `msg_${string}`): Promise<void> {
    await this.deps.messages.append({
      id: messageId,
      transcriptTargetId: sessionId,
      role: 'assistant',
      text: '',
      includeInContext: false,
      createdAt: new Date().toISOString()
    });
  }

  /**
   * Stream one model step with the tool set: text deltas emit live via emitToken; tool-call
   * parts are collected. Returns the streamed prose, client-executable tool-calls, and any
   * provider-executed call/result pairs (already resolved by the provider, e.g. Anthropic
   * web_search) that the loop persists for UI visibility without local re-execution.
   */
  private async streamStep(
    messages: ModelMessage[],
    tools: ToolSpec[],
    emitToken: (delta: string) => void,
    emitReasoning: (delta: string) => void,
    signal: AbortSignal | undefined,
    sessionId: TranscriptTargetId
  ): Promise<{
    text: string;
    reasoning: string;
    calls: ToolCall[];
    providerExecuted: Array<{ call: ToolCall; output: string }>;
    usage?: ModelUsage;
  }> {
    let text = '';
    let reasoning = '';
    let usage: ModelUsage | undefined;
    const calls: ToolCall[] = [];
    // Provider-executed calls buffered until their paired tool-result arrives.
    const pendingProviderCalls = new Map<string, ToolCall>();
    const providerExecuted: Array<{ call: ToolCall; output: string }> = [];

    for await (const chunk of this.deps.model.stream({
      model: this.modelId(),
      messages: await this.beforeModel(sessionId, messages),
      tools,
      sessionId,
      userId: this.deps.userId
    })) {
      if (signal?.aborted) break;
      if (!chunk) continue; // defensive: a provider may yield an empty pull before the next real chunk
      if (chunk.type === 'text') {
        text += chunk.token;
        emitToken(chunk.token);
      } else if (chunk.type === 'reasoning') {
        reasoning += chunk.token;
        emitReasoning(chunk.token);
      } else if (chunk.type === 'tool-call') {
        if (chunk.call.providerExecuted) {
          pendingProviderCalls.set(chunk.call.toolCallId, chunk.call);
        } else {
          calls.push(chunk.call);
        }
      } else if (chunk.type === 'tool-result') {
        const call = pendingProviderCalls.get(chunk.callId);
        if (call) {
          pendingProviderCalls.delete(chunk.callId);
          providerExecuted.push({ call, output: chunk.output });
        }
      } else if (chunk.type === 'usage') {
        usage = chunk.usage;
      }
    }
    // Any provider call whose result never arrived (edge case): treat as empty output.
    for (const call of pendingProviderCalls.values()) {
      providerExecuted.push({ call, output: '' });
    }
    // AfterModel fires per model step here — every streamed step (intermediate tool steps included),
    // paired with this method's BeforeModel, so the rewritten text flows to settle / tools / final.
    const afterText = await this.afterModel(sessionId, text);
    return { text: afterText, reasoning, calls, providerExecuted, usage };
  }

  private applyNonForkSkill(ex: NonNullable<ReturnType<typeof AgentLoop.prototype.resolveExplicitSkill>>): string {
    this.activateSkill(ex.skill.name);
    const body = renderSkillBody(ex.skill.body, ex.argString, ex.skill.dir);
    this.prompt.setSkillExpansion(body);
    return body;
  }

  /** Resolve a user-invocable skill token. Built-in host commands are start-only, but skills may
   * appear inline so the user can write natural text around the explicit skill selection. */
  private resolveExplicitSkill(userText: string): { skill: LoadedSkill; argString: string } | null {
    const parsed = parseSlashCommand(userText);
    if (parsed) {
      const skill = (this.deps.skills ?? []).find((s) => s.name === parsed.name);
      if (skill && skill.userInvocable !== false) return { skill, argString: parsed.args };
    }

    const token = '[a-z0-9]+(?:-[a-z0-9]+)*';
    const skillRef = new RegExp(`(^|\\s)/(${token}(?::${token}){1,2})(?=\\s|$)`, 'g');
    for (const match of userText.matchAll(skillRef)) {
      const skillName = match[2] as string;
      const skill = (this.deps.skills ?? []).find((s) => s.name === skillName);
      if (!skill || skill.userInvocable === false) continue;
      const start = (match.index ?? 0) + (match[1]?.length ?? 0);
      const before = userText.slice(0, start).trim();
      const after = userText.slice(start + skillName.length + 1).trim();
      return { skill, argString: [before, after].filter(Boolean).join('\n\n') };
    }
    return null;
  }

  private skillModelInput(skillName: string, text: string): PersistedModelInputOverride {
    return { modelInput: { kind: 'skill', skillName, text } };
  }

  private async beginTurn(
    sessionId: TranscriptTargetId,
    userText: string,
    modelInput?: PersistedModelInputOverride
  ): Promise<`msg_${string}`> {
    const userMessageId = newId('msg');
    await this.deps.messages.append({
      id: userMessageId,
      transcriptTargetId: sessionId,
      role: 'user',
      text: userText,
      data: modelInput,
      createdAt: new Date().toISOString()
    });
    // Push the accepted user turn so clients that didn't originate it (other tabs, a Telegram-
    // started turn) render the bubble now instead of waiting for the end-of-turn history refetch.
    this.deps.emit(this.event(sessionId, 'user.message', { messageId: userMessageId, text: userText }));
    // The assistant row(s) are NOT opened here. Each assistant text segment is created lazily at its
    // FIRST token (see beginSegment) so it sorts after any tool rows that ran before it. We return
    // the id the first segment will use; a turn with no leading text just never opens it.
    return newId('msg');
  }

  /**
   * One assistant text segment: the row is opened (pending→streaming) lazily on the first token, so
   * a turn's `text → tool → text` sequence persists as ordered rows instead of one flattened row.
   * `settle(text)` writes the final content in place (append-fallback for non-streaming repos); it
   * returns false when the segment produced no text, so the caller can skip an empty row.
   */
  private beginSegment(sessionId: TranscriptTargetId, segmentId: `msg_${string}`, reasonBase: number) {
    let opened = false;
    let tokenIndex = 0;
    let reasonIndex = reasonBase;
    return {
      emitToken: (delta: string): void => {
        if (!opened) {
          opened = true;
          // Synchronous for the store-backed repo (bun:sqlite); a no-op for the in-memory repo.
          void this.deps.messages.open?.({
            id: segmentId,
            transcriptTargetId: sessionId,
            role: 'assistant',
            text: '',
            createdAt: new Date().toISOString()
          });
          void this.deps.messages.markStreaming?.(sessionId, segmentId);
        }
        this.deps.emit(this.event(sessionId, 'agent.token', { messageId: segmentId, delta, index: tokenIndex++ }));
      },
      emitReasoning: (delta: string): void => this.emitReasoning(sessionId, segmentId, delta, reasonIndex++),
      reasonIndex: (): number => reasonIndex,
      settle: async (text: string, reasoning?: string): Promise<boolean> => {
        if (!opened && text === '') return false;
        const message: ChatMessage = {
          id: segmentId,
          transcriptTargetId: sessionId,
          role: 'assistant',
          text,
          createdAt: new Date().toISOString(),
          ...(reasoning ? { data: { reasoning } } : {})
        };
        const settled = this.deps.messages.settle ? await this.deps.messages.settle(message, 'complete') : false;
        if (!settled) await this.deps.messages.append(message);
        return true;
      }
    };
  }

  private async finishTurn(
    sessionId: TranscriptTargetId,
    messageId: `msg_${string}`,
    text: string,
    usage?: AgentMessagePayload['usage'],
    finishReason?: AgentMessagePayload['finishReason'],
    reasoning?: string
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: messageId,
      transcriptTargetId: sessionId,
      role: 'assistant',
      text,
      createdAt: new Date().toISOString(),
      // Persist the extended-thinking trace alongside the answer so the UI can show it from
      // history (the live `agent.reasoning` deltas are transient). Carried in `data`, which
      // replayHistory ignores for prose turns — so it never costs prompt tokens on later turns.
      ...(reasoning ? { data: { reasoning } } : {})
    };
    // Non-streaming (block) turns have no open segment row, so settle finds nothing and we append —
    // landing the assistant row after the turn's tool rows (correct order).
    const settled = this.deps.messages.settle ? await this.deps.messages.settle(message, 'complete') : false;
    if (!settled) await this.deps.messages.append(message);
    await this.finishBookkeeping(sessionId, messageId, text, usage, finishReason);
    return message;
  }

  /** Per-turn accounting + events, emitted once after the final assistant content is persisted:
   * record real usage/cost, self-calibrate the token estimator, emit `agent.message` and the
   * `context.usage` breakdown. The assistant row itself is written by the segment/finishTurn path. */
  private async finishBookkeeping(
    sessionId: TranscriptTargetId,
    messageId: `msg_${string}`,
    text: string,
    usage?: AgentMessagePayload['usage'],
    finishReason?: AgentMessagePayload['finishReason']
  ): Promise<void> {
    const cost = usage ? this.deps.recordTurnUsage?.(sessionId, usage, this.modelId()) : undefined;
    this.prompt.observeEstimator(usage);
    const payload: AgentMessagePayload = { messageId, text, usage, ...(cost ? { cost } : {}), finishReason };
    this.deps.emit(this.event(sessionId, 'agent.message', payload));
    await this.prompt.emitContextUsage(
      sessionId,
      this.availableTools.length > 0,
      usage?.inputTokens,
      this.turnInjectedContext
    );
  }

  /**
   * Fire the Stop hook at a turn's final answer. Returns the (possibly rewritten) final text and, in
   * the agentic tool loops, a `continueReason` when a hook forces the agent to keep working — bounded
   * by `maxStopContinues` so a hook can't loop forever. Fired exactly once per final-answer decision.
   */
  private async runStopHook(
    sessionId: TranscriptTargetId,
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

  /** Best-effort re-persist of a settled segment when a Stop hook rewrote the final text (the
   * streamed row was already settled with the original). No-op for repos without `settle`. */
  private async repersistFinalText(
    sessionId: TranscriptTargetId,
    messageId: `msg_${string}`,
    text: string
  ): Promise<void> {
    await this.deps.messages.settle?.(
      { id: messageId, transcriptTargetId: sessionId, role: 'assistant', text, createdAt: new Date().toISOString() },
      'complete'
    );
  }

  /** Emit one reasoning/extended-thinking delta on its own channel (transient, not persisted). */
  private emitReasoning(sessionId: TranscriptTargetId, messageId: `msg_${string}`, delta: string, index: number): void {
    const payload: AgentReasoningPayload = { messageId, delta, index };
    this.deps.emit(this.event(sessionId, 'agent.reasoning', payload));
  }

  private async emitError(sessionId: TranscriptTargetId, messageId: string, err: unknown): Promise<void> {
    const { code, message } = extractError(err);
    const text = code ? `[${code}] ${message}` : message;
    // Persist the failure as an assistant message so it survives in history and is visible even when
    // the live event stream can't deliver. Tagged `error` so buildPrompt never replays it back to
    // the model. Settle the row opened in beginTurn (→ error); repos without the lifecycle append it.
    const errMessage: ChatMessage = {
      id: messageId,
      transcriptTargetId: sessionId,
      role: 'assistant',
      text,
      createdAt: new Date().toISOString(),
      type: 'error'
    };
    try {
      const settled = this.deps.messages.settle ? await this.deps.messages.settle(errMessage, 'error') : false;
      if (!settled) await this.deps.messages.append(errMessage);
    } catch (appendErr) {
      // A turn can fail after the assistant row is already persisted (e.g. post-persist side
      // effects). Re-using the same messageId must not crash the daemon on a duplicate insert.
      if (!String(appendErr).includes('UNIQUE constraint failed: messages.id')) throw appendErr;
    }
    this.deps.emit(this.event(sessionId, 'agent.error', { messageId, code, message }));
    // AfterTurn also fires when a turn ends in failure (the success path fires it via runStopHook).
    // Observe-only here — the turn already errored; a hook can log/notify but not rewrite the answer.
    await this.hooks.run({
      event: 'AfterTurn',
      sessionId,
      cwd: this.hookCwd(),
      timestamp: new Date().toISOString(),
      reason: 'error',
      ok: false,
      error: text
    });
  }

  private event(sessionId: TranscriptTargetId, type: EventType, payload: object): Event {
    return {
      id: newId('evt'),
      transcriptTargetId: sessionId,
      type,
      actorAgentId: null,
      payload: payload as Record<string, unknown>,
      at: new Date().toISOString()
    };
  }
}
