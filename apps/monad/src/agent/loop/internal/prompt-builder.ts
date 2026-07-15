import type { EventType, SessionId } from '@monad/protocol';
import type { Tool } from '#/capabilities/tools/types.ts';
import type { ModelContentPart, ModelMessage, ModelUsage, ToolSpec } from '../../model/index.ts';
import type { AgentLoopDeps, ImageAttachment } from '../types.ts';

import { includeInContext } from '@monad/protocol';

import { toolInputJsonSchema } from '#/capabilities/tools/schema.ts';
import { ContextBuilder } from '../../context/budget.ts';
import { estimateTokensCached, globalEstimator } from '../../context/estimate.ts';
import { messageChars } from '../../context/index.ts';
import { renderAgentSystemPrompt, renderContextSummary, renderEnvironment } from '../../prompts.ts';
import { replayHistory } from '../replay.ts';

/**
 * Owns everything needed to assemble the model-facing prompt for a turn: history replay,
 * system-prompt rendering, tool-spec caching, context-window bookkeeping, and the turn-scoped
 * skill/attachment state that rides the last user message. Split out of AgentLoop because this
 * state and its methods form a self-contained "what goes into the next model call" concern,
 * distinct from turn lifecycle and tool execution.
 */
export class PromptBuilder {
  // Turn-scoped: reset at the start of every runStream/runBlock call.
  private turnAttachments?: ImageAttachment[];
  private pendingSkillExpansion: string | null = null;
  private pendingUserTextOverride: string | null = null;

  // Chars of the prompt actually sent on the last model step — paired with the provider's real
  // input tokens in finishBookkeeping to self-calibrate the chars/token estimator.
  private lastSentChars = 0;

  // The provider's real input-token count from the most recent model step, retained across steps
  // and turns. Fed to the context engine so window-fraction decisions rest on a real count rather
  // than a whole-window estimate. Undefined until the first step reports usage.
  private lastRealInputTokens?: number;

  // Cached per tool-revision: recomputed whenever getToolRevision() returns a new value (e.g. a
  // new MCP server connected mid-session). Within a stable revision, the same ToolSpec array is
  // returned every turn so the outer model's prefix cache holds across turns.
  // Note: z.toJSONSchema is not free, so memoizing also avoids per-turn schema derivation cost.
  private cachedToolSpecs?: ToolSpec[];
  private cachedToolSpecsRevision?: number;

  // Token threshold above which deferred tool-search mode activates.
  private static readonly TOOL_SEARCH_THRESHOLD = 8_000;

  constructor(
    private readonly deps: AgentLoopDeps,
    private readonly availableTools: () => Tool[],
    private readonly modelId: () => string,
    private readonly emitEvent: (sessionId: SessionId, type: EventType, payload: object) => void
  ) {}

  setAttachments(attachments?: ImageAttachment[]): void {
    this.turnAttachments = attachments;
  }

  resetSkillExpansion(): void {
    this.pendingSkillExpansion = null;
    this.pendingUserTextOverride = null;
  }

  setSkillExpansion(text: string): void {
    this.pendingSkillExpansion = text;
  }

  setUserTextOverride(text: string): void {
    this.pendingUserTextOverride = text;
  }

  /** Record a model step's real input-token count for the next prepare() to use as its base. */
  noteUsage(usage?: ModelUsage): void {
    if (usage?.inputTokens && usage.inputTokens > 0) this.lastRealInputTokens = usage.inputTokens;
  }

  /** Run the assembled prompt through the context engine (truncate/summarize) before sending. */
  async prepare(sessionId: SessionId, messages: ModelMessage[]): Promise<ModelMessage[]> {
    const sent = this.deps.context
      ? await this.deps.context.prepare(messages, {
          sessionId,
          emit: this.deps.emit,
          estimator: globalEstimator,
          lastRealInputTokens: this.lastRealInputTokens
        })
      : messages;
    this.lastSentChars = sent.reduce((sum, m) => sum + messageChars(m), 0);
    return sent;
  }

  private toSpec(t: Tool): ToolSpec {
    return {
      name: t.name,
      description: t.description,
      parameters: toolInputJsonSchema(t),
      ...(t.providerTool ? { providerTool: t.providerTool } : {})
    };
  }

  private shouldDefer(): boolean {
    const cfg = this.deps.toolSearchConfig;
    const threshold = cfg?.threshold ?? PromptBuilder.TOOL_SEARCH_THRESHOLD;
    if (!cfg || threshold === 0) return false;
    const charCount = this.availableTools().reduce(
      (s, t) => s + t.name.length + t.description.length + JSON.stringify(toolInputJsonSchema(t) ?? {}).length,
      0
    );
    return Math.ceil(charCount / 4) > threshold;
  }

  toolSpecs(): ToolSpec[] {
    const revision = this.deps.toolSearchConfig?.getToolRevision?.();
    if (revision !== undefined && revision !== this.cachedToolSpecsRevision) {
      this.cachedToolSpecs = undefined;
      this.cachedToolSpecsRevision = revision;
    }
    if (!this.cachedToolSpecs) {
      const cfg = this.deps.toolSearchConfig;
      const availableTools = this.availableTools();
      if (cfg && this.shouldDefer()) {
        // Deferred mode: expose only builtins + tool_search + tool_call to the outer model.
        // MCP tools remain in availableTools so executeToolCall can dispatch them via tool_call.
        const visible = availableTools.filter(
          (t) => cfg.builtinToolNames.has(t.name) || t.name === 'tool_search' || t.name === 'tool_call'
        );
        this.cachedToolSpecs = visible.map((t) => this.toSpec(t));
      } else {
        // Normal mode: all tools, but hide tool_search/tool_call when not needed (no-op if cfg absent).
        const tools = cfg
          ? availableTools.filter((t) => t.name !== 'tool_search' && t.name !== 'tool_call')
          : availableTools;
        this.cachedToolSpecs = tools.map((t) => this.toSpec(t));
      }
    }
    return this.cachedToolSpecs;
  }

  // Tools are offered to the model natively (function-calling), so the system prompt only
  // carries the L1 skill listing here; the model pulls a skill body via the `skill` tool.
  /** The host's optional custom system instructions. Undefined selects the built-in Eta template. */
  private systemInstructions(sessionId?: SessionId): string | undefined {
    return typeof this.deps.instructions === 'function' ? this.deps.instructions(sessionId) : this.deps.instructions;
  }

  private userPromptSlots(sessionId?: SessionId) {
    const resolved =
      typeof this.deps.promptSlots === 'function' ? this.deps.promptSlots(sessionId) : this.deps.promptSlots;
    return resolved ?? {};
  }

  async buildPrompt(sessionId: SessionId, withTools = false, injectedContext: string[] = []): Promise<ModelMessage[]> {
    let replayed: ModelMessage[];
    let summary: string | undefined;
    if (this.deps.history) {
      // Durable bounded-load: only messages since the summary boundary, summary folded below.
      const assembled = await this.deps.history.assemble(sessionId);
      replayed = assembled.messages;
      summary = assembled.summary;
    } else {
      const history = await this.deps.messages.list(sessionId);
      replayed = this.deps.promptCache ? this.deps.promptCache.replay(sessionId, history) : replayHistory(history);
    }
    // NB: ambientContext is intentionally NOT a system slot — it changes every turn and would bust
    // the prompt-cache breakpoint on the system message. It rides the last user message instead.
    const system = renderAgentSystemPrompt({
      instructions: this.systemInstructions(sessionId),
      slots: {
        ...this.userPromptSlots(sessionId),
        environment: renderEnvironment(this.deps.environment),
        // Hook-injected context (SessionStart + UserPromptSubmit additionalContext), folded into the
        // system prompt so it reaches the model this turn.
        injectedContext: injectedContext.length ? injectedContext.join('\n\n') : undefined
      },
      skills: withTools ? (this.deps.skills ?? []) : [],
      toolNames: withTools ? this.availableTools().map((t) => t.name) : []
    });
    // Spread `replayed` into a fresh array: the turn appends tool steps to the result, and the
    // cached array must stay immutable for the next turn (and for cross-turn token-cache reuse).
    const systemMsg: ModelMessage = { role: 'system', content: system };
    if (this.deps.cacheSystemPrompt) systemMsg.cache = true; // prompt-cache the static prefix
    return this.withContextSummary(this.composeUserTurn([systemMsg, ...replayed]), summary);
  }

  private withContextSummary(messages: ModelMessage[], summary: string | undefined): ModelMessage[] {
    if (!summary) return messages;
    const summaryText = `${renderContextSummary(summary)}\n\n`;
    const next = [...messages];
    const firstNonSystem = next.findIndex((m) => m.role !== 'system');
    if (firstNonSystem === -1) {
      next.push({ role: 'user', content: summaryText.trimEnd() });
      return next;
    }
    const first = next[firstNonSystem];
    if (first?.role !== 'user') {
      next.splice(firstNonSystem, 0, { role: 'user', content: summaryText.trimEnd() });
      return next;
    }
    if (typeof first.content === 'string') {
      next[firstNonSystem] = { ...first, content: `${summaryText}${first.content}` };
      return next;
    }
    next[firstNonSystem] = {
      ...first,
      content: [{ type: 'text', text: summaryText }, ...first.content]
    };
    return next;
  }

  /** Fold this turn's ambient context (e.g. editor open documents) and image attachments into the
   * last user message. Both ride the user turn rather than the system prompt so the prompt-cache
   * breakpoint on the system message keeps hitting across turns. Replaces (never mutates) the
   * message — buildPrompt's user messages may be shared promptCache objects. */
  private composeUserTurn(messages: ModelMessage[]): ModelMessage[] {
    const ambient = this.deps.ambientContext;
    const skillBody = this.pendingSkillExpansion;
    const userTextOverride = this.pendingUserTextOverride;
    this.pendingSkillExpansion = null;
    this.pendingUserTextOverride = null;
    const images: ModelContentPart[] = (this.turnAttachments ?? []).map((a) => ({
      type: 'image',
      image: a.image,
      mediaType: a.mediaType
    }));
    if (!ambient && !skillBody && userTextOverride === null && images.length === 0) return messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'user') {
        const text =
          userTextOverride ??
          skillBody ??
          (typeof m.content === 'string'
            ? m.content
            : (m.content as ModelContentPart[])
                .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                .map((p) => p.text)
                .join(''));
        const parts: ModelContentPart[] = [];
        if (ambient) parts.push({ type: 'text', text: ambient });
        parts.push({ type: 'text', text });
        parts.push(...images);
        const next = [...messages];
        next[i] = { role: 'user', content: parts };
        return next;
      }
    }
    return messages;
  }

  /**
   * Emit a `context.usage` breakdown for this turn (no-op without a configured contextLimit).
   * Itemizes the static prompt parts (system prompt, skill listing, each tool schema) with a
   * local estimator. The messages bucket prefers the provider's reported prompt size
   * (`inputTokens`) as ground truth — the static estimate is subtracted out so the segments
   * still sum to the real total — and falls back to a local estimate when the provider returns
   * no usage. Clients group the itemized segments by category for the `/context` view.
   */
  async emitContextUsage(
    sessionId: SessionId,
    withTools: boolean,
    inputTokens?: number,
    injectedContext: string[] = []
  ): Promise<void> {
    const contextLimit = this.deps.contextLimit;
    if (!contextLimit) return;

    const builder = new ContextBuilder();
    builder.add(
      'systemPrompt',
      'System prompt',
      renderAgentSystemPrompt({
        instructions: this.systemInstructions(sessionId),
        slots: this.userPromptSlots(sessionId),
        skills: withTools ? (this.deps.skills ?? []) : [],
        toolNames: withTools ? this.availableTools().map((t) => t.name) : []
      })
    );
    if (withTools) {
      for (const spec of this.toolSpecs()) builder.add('systemTools', spec.name, JSON.stringify(spec));
    }
    const staticTokens = builder.list().reduce((sum, s) => sum + s.tokens, 0);

    // Authoritative whole-request total, best-first: this turn's real provider usage, else a native
    // count_tokens call (exact, but a network round-trip so only on the no-usage path — the first
    // turn, or providers that never report usage), else a local char estimate of history below.
    let total = inputTokens;
    if (total === undefined && this.deps.model.countTokens) {
      total = await this.deps.model.countTokens({
        model: this.modelId(),
        messages: await this.buildPrompt(sessionId, withTools, injectedContext),
        ...(withTools ? { tools: this.toolSpecs() } : {})
      });
    }

    if (total !== undefined) {
      // Whole-request total is authoritative; messages absorbs everything not in the static buckets.
      builder.addTokens('messages', 'Messages', Math.max(0, total - staticTokens));
    } else if (!this.deps.history) {
      // No real or native count: estimate from history. Skipped when a durable HistoryProvider is
      // active — full-loading here would defeat its bounded-load purpose; we rely on provider usage.
      const history = await this.deps.messages.list(sessionId);
      const tokens = history.reduce(
        (sum, m) => (includeInContext(m) ? sum + estimateTokensCached(m.id, m.text) : sum),
        0
      );
      builder.addTokens('messages', 'Messages', tokens);
    }

    const usage = builder.build({
      contextLimit,
      approximate: total === undefined,
      reclaimed: this.deps.evictedTokens?.(sessionId)
    });
    this.emitEvent(sessionId, 'context.usage', usage);

    // Handoff nudge: this is only ever called at a settled task boundary (end of a turn — see
    // TurnWriter.finishBookkeeping's call sites), never mid tool-loop, so firing here is exactly
    // "at a task boundary" without extra state tracking.
    const atFraction = this.deps.handoffNudgeFraction;
    if (atFraction !== undefined) {
      const usedFraction = usage.used / usage.contextLimit;
      if (usedFraction >= atFraction) {
        this.emitEvent(sessionId, 'context.handoff_suggested', { usedFraction, atFraction });
      }
    }
  }

  observeEstimator(usage?: ModelUsage): void {
    globalEstimator.observe(this.lastSentChars, usage?.inputTokens);
  }
}
