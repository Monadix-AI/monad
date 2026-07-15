import type { Cost, Event, EventType, SessionId } from '@monad/protocol';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { ModelMessage, ModelUsage, ToolCall, ToolSpec } from '../model/index.ts';
import type { ExplicitSkill } from './internal/explicit-skill.ts';
import type { AgentLoopDeps, ChatMessage, ImageAttachment } from './types.ts';

import { finishReasonSchema, newId } from '@monad/protocol';

import { computeCost } from '../model/cost.ts';
import { BUDGET_EXCEEDED, TOOL_BUDGET_REACHED } from '../prompts.ts';
import { resolveExplicitSkill, skillModelInput } from './internal/explicit-skill.ts';
import { HookOrchestrator } from './internal/hook-orchestrator.ts';
import { PromptBuilder } from './internal/prompt-builder.ts';
import { ToolExecutor } from './internal/tool-execution.ts';
import { ToolGrant } from './internal/tool-grant.ts';
import { TurnWriter } from './internal/turn-writer.ts';
import { renderSkillBody } from './skill-render.ts';

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

export class AgentLoop {
  // Hook orchestration (BeforeTurn/BeforeModel/AfterModel/AfterTurn) and the turn-scoped state
  // hooks contribute (model override, injected context, stop-continue count).
  private readonly hookOrchestrator: HookOrchestrator;

  // Tool patterns pre-approved by skills active this turn (allowed-tools) and the approval-gate
  // wrapper that honours them. The loop is created fresh per turn, so this is turn-scoped — no
  // cross-session/turn leakage.
  private readonly toolGrant: ToolGrant;

  // History replay, system-prompt rendering, tool-spec caching, and context-window bookkeeping.
  private readonly prompt: PromptBuilder;

  // Gate/hook orchestration around invokeTool, result truncation, and tool round-trip persistence.
  private readonly toolExecutor: ToolExecutor;

  // Turn output persistence: user/assistant rows, streaming segments, usage bookkeeping, errors.
  private readonly writer: TurnWriter;

  constructor(private readonly deps: AgentLoopDeps) {
    this.hookOrchestrator = new HookOrchestrator(deps);
    this.toolGrant = new ToolGrant(
      deps,
      () => this.hookOrchestrator.hooks,
      () => this.hookOrchestrator.hookCwd()
    );
    this.prompt = new PromptBuilder(
      deps,
      () => this.availableTools,
      () => this.hookOrchestrator.modelId(),
      (sessionId, type, payload) => this.deps.emit(this.event(sessionId, type, payload))
    );
    this.toolExecutor = new ToolExecutor(
      deps,
      () => this.availableTools,
      () => this.hookOrchestrator.hooks,
      () => this.hookOrchestrator.hookCwd(),
      () => this.toolGrant.effectiveGate(),
      (sessionId, type, payload) => this.deps.emit(this.event(sessionId, type, payload)),
      (context) => this.hookOrchestrator.turnInjectedContext.push(...context),
      (name) => this.toolGrant.activateSkill(name)
    );
    this.writer = new TurnWriter(
      deps,
      (sessionId, type, payload) => this.deps.emit(this.event(sessionId, type, payload)),
      () => this.prompt,
      () => this.availableTools,
      () => this.hookOrchestrator.modelId(),
      () => this.hookOrchestrator.turnInjectedContext,
      () => this.hookOrchestrator.hooks,
      () => this.hookOrchestrator.hookCwd()
    );
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

  async runStream(
    sessionId: SessionId,
    userText: string,
    signal?: AbortSignal,
    attachments?: ImageAttachment[]
  ): Promise<void> {
    this.prompt.setAttachments(attachments);
    this.prompt.resetSkillExpansion();
    const submit = await this.hookOrchestrator.userPromptSubmit(sessionId, userText);
    if (submit.blocked) {
      // Persist the user's (raw) prompt before the policy reply so the transcript shows what was
      // denied — a denied turn still has a user bubble, not an orphan assistant message.
      const messageId = await this.writer.beginTurn(sessionId, userText);
      await this.writer.finishTurn(sessionId, messageId, submit.reason);
      return;
    }
    userText = submit.text;
    // Explicit `/name` of a `context: fork` skill → run it as an isolated subagent and emit
    // only its result (consistent with the model auto-loading a fork skill).
    const ex = resolveExplicitSkill(this.deps.skills ?? [], userText);
    if (ex?.skill.fork && this.deps.runFork) {
      const messageId = await this.writer.beginTurn(sessionId, userText);
      this.toolGrant.activateSkill(ex.skill.name);
      try {
        const result = await this.deps.runFork(
          renderSkillBody(ex.skill.body, ex.argString, ex.skill.dir),
          { sessionId, sandboxRoots: this.deps.sandboxRoots, backends: this.deps.backends },
          ex.skill.tier,
          ex.skill.name
        );
        this.deps.emit(this.event(sessionId, 'agent.token', { messageId, delta: result, index: 0 }));
        await this.writer.finishTurn(sessionId, messageId, result);
      } catch (err) {
        await this.writer.emitError(sessionId, messageId, err);
        throw err;
      }
      return;
    }

    const modelInput = ex ? skillModelInput(ex.skill.name, this.applyNonForkSkill(ex)) : undefined;
    const messageId = await this.writer.beginTurn(sessionId, userText, modelInput);

    await this.runAssistantStream(sessionId, messageId, signal);
  }

  async runStreamFromHistory(sessionId: SessionId, signal?: AbortSignal): Promise<void> {
    this.prompt.setAttachments(undefined);
    this.prompt.resetSkillExpansion();
    const history = await this.deps.messages.list(sessionId);
    const trailingUser = [...history].reverse().find((message) => message.role === 'user');
    if (!trailingUser) throw new Error('history continuation requires a user message');
    const submit = await this.hookOrchestrator.userPromptSubmit(sessionId, trailingUser.text);
    const messageId = newId('msg');
    if (submit.blocked) {
      await this.writer.finishTurn(sessionId, messageId, submit.reason);
      return;
    }
    this.prompt.setUserTextOverride(submit.text);
    await this.runAssistantStream(sessionId, messageId, signal);
  }

  private async runAssistantStream(
    sessionId: SessionId,
    messageId: `msg_${string}`,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      if (this.availableTools.length > 0) {
        await this.runStreamWithTools(sessionId, messageId, signal);
        return;
      }

      const messages = await this.prompt.prepare(sessionId, await this.prompt.buildPrompt(sessionId));
      const seg = this.writer.beginSegment(sessionId, messageId, 0);
      let text = '';
      let reasoning = '';
      let usage: ModelUsage | undefined;
      for await (const chunk of this.deps.model.stream({
        model: this.hookOrchestrator.modelId(),
        messages: await this.hookOrchestrator.beforeModel(sessionId, messages),
        params: this.deps.generationParams,
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
      text = await this.hookOrchestrator.afterModel(sessionId, text);
      if (!(await seg.settle(text, reasoning))) await this.writer.appendEmptyAnswer(sessionId, messageId);
      // No tool loop here, so a Stop hook can only observe + rewrite the final text (no continuation).
      const stop = await this.hookOrchestrator.runStopHook(
        sessionId,
        text,
        usage,
        signal?.aborted ? 'aborted' : 'completed'
      );
      if (stop.text !== text) await this.writer.repersistFinalText(sessionId, messageId, stop.text);
      await this.writer.finishBookkeeping(sessionId, messageId, stop.text, usage);
    } catch (err) {
      await this.writer.emitError(sessionId, messageId, err);
      throw err;
    }
  }

  async runBlock(sessionId: SessionId, userText: string, attachments?: ImageAttachment[]): Promise<ChatMessage> {
    this.prompt.setAttachments(attachments);
    this.prompt.resetSkillExpansion();
    const submit = await this.hookOrchestrator.userPromptSubmit(sessionId, userText);
    if (submit.blocked) {
      const messageId = await this.writer.beginTurn(sessionId, userText);
      return this.writer.finishTurn(sessionId, messageId, submit.reason);
    }
    userText = submit.text;
    // Explicit `/name` of a `context: fork` skill → run it as an isolated subagent, returning
    // only its result.
    const ex = resolveExplicitSkill(this.deps.skills ?? [], userText);
    if (ex?.skill.fork && this.deps.runFork) {
      const messageId = await this.writer.beginTurn(sessionId, userText);
      this.toolGrant.activateSkill(ex.skill.name);
      try {
        const result = await this.deps.runFork(
          renderSkillBody(ex.skill.body, ex.argString, ex.skill.dir),
          { sessionId, sandboxRoots: this.deps.sandboxRoots, backends: this.deps.backends },
          ex.skill.tier,
          ex.skill.name
        );
        return this.writer.finishTurn(sessionId, messageId, result);
      } catch (err) {
        await this.writer.emitError(sessionId, messageId, err);
        throw err;
      }
    }

    const modelInput = ex ? skillModelInput(ex.skill.name, this.applyNonForkSkill(ex)) : undefined;
    const messageId = await this.writer.beginTurn(sessionId, userText, modelInput);

    try {
      if (this.availableTools.length > 0) {
        const { text, usage } = await this.runToolLoop(sessionId);
        return this.writer.finishTurn(sessionId, messageId, text, usage);
      }

      const messages = await this.prompt.prepare(sessionId, await this.prompt.buildPrompt(sessionId));
      const result = await this.deps.model.complete({
        model: this.hookOrchestrator.modelId(),
        messages: await this.hookOrchestrator.beforeModel(sessionId, messages),
        params: this.deps.generationParams,
        sessionId,
        userId: this.deps.userId
      });
      const parsed = finishReasonSchema.safeParse(result.finishReason);
      this.prompt.noteUsage(result.usage);
      const responseText = await this.hookOrchestrator.afterModel(sessionId, result.text);
      const stop = await this.hookOrchestrator.runStopHook(sessionId, responseText, result.usage);
      return this.writer.finishTurn(
        sessionId,
        messageId,
        stop.text,
        result.usage,
        parsed.success ? parsed.data : undefined
      );
    } catch (err) {
      await this.writer.emitError(sessionId, messageId, err);
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
  private async runToolLoop(sessionId: SessionId): Promise<{ text: string; usage?: ModelUsage }> {
    const maxTurns = this.deps.maxTurns;
    const maxBudgetUsd = this.deps.maxBudgetUsd;
    let messages = await this.prompt.buildPrompt(sessionId, true, this.hookOrchestrator.turnInjectedContext);
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
        model: this.hookOrchestrator.modelId(),
        messages: await this.hookOrchestrator.beforeModel(sessionId, messages),
        params: this.deps.generationParams,
        tools,
        sessionId,
        userId: this.deps.userId
      });
      this.prompt.noteUsage(result.usage);
      // AfterModel fires per model step — including the intermediate responses that carry tool calls.
      const responseText = await this.hookOrchestrator.afterModel(sessionId, result.text);

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
        const stop = await this.hookOrchestrator.runStopHook(sessionId, responseText, result.usage);
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
      model: this.hookOrchestrator.modelId(),
      messages: await this.hookOrchestrator.beforeModel(sessionId, messages),
      params: this.deps.generationParams,
      sessionId,
      userId: this.deps.userId
    });
    const stop = await this.hookOrchestrator.runStopHook(
      sessionId,
      await this.hookOrchestrator.afterModel(sessionId, result.text),
      result.usage
    );
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
    sessionId: SessionId,
    messageId: `msg_${string}`,
    signal?: AbortSignal
  ): Promise<void> {
    const maxTurns = this.deps.maxTurns;
    const maxBudgetUsd = this.deps.maxBudgetUsd;
    let messages = await this.prompt.buildPrompt(sessionId, true, this.hookOrchestrator.turnInjectedContext);
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
      const seg = this.writer.beginSegment(sessionId, segmentId, reasonBase);
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
        const stop = await this.hookOrchestrator.runStopHook(
          sessionId,
          text,
          lastUsage,
          signal?.aborted ? 'aborted' : 'completed'
        );
        if (stop.continueReason) {
          // Record this (already-settled) answer in the model context, inject the continue
          // instruction, and re-enter with a fresh segment.
          messages.push({ role: 'assistant', content: text || '(continuing)' });
          messages.push({ role: 'user', content: stop.continueReason });
          segmentId = newId('msg');
          continue;
        }
        // The final step IS the answer. Ensure an assistant row exists even for an empty answer.
        if (!wrote) await this.writer.appendEmptyAnswer(sessionId, segmentId);
        if (stop.text !== text) await this.writer.repersistFinalText(sessionId, segmentId, stop.text);
        await this.writer.finishBookkeeping(sessionId, segmentId, stop.text, lastUsage);
        return;
      }
      await this.toolExecutor.runToolCalls(sessionId, text, calls, messages, signal);
      segmentId = newId('msg'); // the next step's text is a fresh, later-sorting segment
    }

    // Budget exhausted (turn limit or cost) — stream a direct answer with no tools offered.
    const budgetMsg = budgetExceeded() ? BUDGET_EXCEEDED : TOOL_BUDGET_REACHED;
    messages.push({ role: 'user', content: budgetMsg });
    const seg = this.writer.beginSegment(sessionId, segmentId, reasonBase);
    let finalText = '';
    let finalUsage: ModelUsage | undefined;
    for await (const chunk of this.deps.model.stream({
      model: this.hookOrchestrator.modelId(),
      messages: await this.hookOrchestrator.beforeModel(sessionId, messages),
      params: this.deps.generationParams,
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
    if (!(await seg.settle(finalText))) await this.writer.appendEmptyAnswer(sessionId, segmentId);
    const stop = await this.hookOrchestrator.runStopHook(
      sessionId,
      await this.hookOrchestrator.afterModel(sessionId, finalText),
      finalUsage ?? lastUsage,
      signal?.aborted ? 'aborted' : 'completed'
    );
    if (stop.text !== finalText) await this.writer.repersistFinalText(sessionId, segmentId, stop.text);
    await this.writer.finishBookkeeping(sessionId, segmentId, stop.text, finalUsage ?? lastUsage);
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
    sessionId: SessionId
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
      model: this.hookOrchestrator.modelId(),
      messages: await this.hookOrchestrator.beforeModel(sessionId, messages),
      params: this.deps.generationParams,
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
    const afterText = await this.hookOrchestrator.afterModel(sessionId, text);
    return { text: afterText, reasoning, calls, providerExecuted, usage };
  }

  private applyNonForkSkill(ex: ExplicitSkill): string {
    this.toolGrant.activateSkill(ex.skill.name);
    const body = renderSkillBody(ex.skill.body, ex.argString, ex.skill.dir);
    this.prompt.setSkillExpansion(body);
    return body;
  }

  private event(sessionId: SessionId, type: EventType, payload: object): Event {
    return {
      id: newId('evt'),
      sessionId,
      type,
      actorAgentId: null,
      payload: payload as Record<string, unknown>,
      at: new Date().toISOString()
    };
  }
}
