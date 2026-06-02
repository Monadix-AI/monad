// ContextEngine — the seam that keeps a turn's prompt within the model's window. The loop
// runs the assembled messages through `prepare()` before every model step. Two built-ins:
//
//   • TokenLimiterContext   — pure truncation (drop oldest, keep a contiguous recent suffix).
//   • SummarizingContextEngine — Mastra Observational-Memory style: summarize old turns into
//     an append-only system note (cache-friendly), compacting in the BACKGROUND so the main
//     agent isn't blocked, with a synchronous fallback once a hard threshold is crossed.
//
// Default is passthrough (no-op). The daemon opts a session into a real engine.

import type { Event } from '@monad/protocol';
import type { Memory } from '../memory/index.ts';
import type { ModelContentPart, ModelMessage, ModelRouter } from '../model/index.ts';

import { SUMMARY_MARKER, SUMMARY_PROMPT } from '../prompts.ts';
import { globalEstimator, type TokenEstimator } from './estimate.ts';

export interface ContextPrepareCtx {
  sessionId: string;
  emit(event: Event): void;
  /** Per-session token estimator (self-calibrating char ratio). Defaults to the global one. */
  estimator?: TokenEstimator;
  /** The provider's real input-token count from the last turn, if any — a more accurate base
   *  for threshold decisions than estimating the whole window. */
  lastRealInputTokens?: number;
}

export interface ContextEngine {
  /** Called before each model step; returns the (possibly compacted) messages to send. */
  prepare(messages: ModelMessage[], ctx: ContextPrepareCtx): ModelMessage[] | Promise<ModelMessage[]>;
}

/** No-op engine — the default; sends the prompt through unchanged. */
export const passthroughContext: ContextEngine = { prepare: (m) => m };

/** Backstop cap on per-session compaction state held by a long-lived engine. */
const MAX_TRACKED_SESSIONS = 1000;

/**
 * Runs engines in sequence, threading the output of one into the next. Use it to put a hard
 * guard after a soft one: `[SummarizingContextEngine, TokenLimiterContext]` summarizes first,
 * then truncates as a last resort if summarization failed or lagged — so the window can never
 * overflow even when the summary model errors.
 */
export class CompositeContextEngine implements ContextEngine {
  constructor(private readonly engines: ContextEngine[]) {}

  async prepare(messages: ModelMessage[], ctx: ContextPrepareCtx): Promise<ModelMessage[]> {
    let out = messages;
    for (const engine of this.engines) out = await engine.prepare(out, ctx);
    return out;
  }
}

// ── token accounting ──────────────────────────────────────────────────────────────

function partText(p: ModelContentPart): string {
  switch (p.type) {
    case 'text':
      return p.text;
    case 'tool-call':
      return `${p.toolName}${JSON.stringify(p.input)}`;
    case 'tool-result':
      return p.output;
    case 'image':
      return ''; // images don't contribute text tokens to the estimate
  }
}

/** Total character length of a message's content (images contribute 0). */
export function messageChars(m: ModelMessage): number {
  return typeof m.content === 'string' ? m.content.length : m.content.reduce((sum, p) => sum + partText(p).length, 0);
}

// A ModelMessage's content is immutable once appended, so its CHAR length is a pure function of
// object identity — cache that (not the token count). Tokens are derived by dividing the cached
// chars by the estimator's CURRENT ratio at read time, so a self-calibrating ratio never staleens
// the cache. Caching by identity also keeps per-step prepare() at O(turns), not O(turns²).
const charCache = new WeakMap<ModelMessage, number>();

export function messageTokens(m: ModelMessage, est: TokenEstimator = globalEstimator): number {
  let chars = charCache.get(m);
  if (chars === undefined) {
    chars = messageChars(m);
    charCache.set(m, chars);
  }
  return est.fromChars(chars);
}

function totalTokens(messages: ModelMessage[], est: TokenEstimator = globalEstimator): number {
  return messages.reduce((sum, m) => sum + messageTokens(m, est), 0);
}

// ── TokenLimiter (pure truncation) ──────────────────────────────────────────────

export interface TokenLimiterOptions {
  /** Hard cap on prompt tokens; the most recent messages that fit are kept. */
  maxTokens: number;
}

/**
 * Drop oldest-first, keeping system messages and the longest contiguous *recent* suffix that
 * fits the budget. A leading orphan tool-result (whose tool-call got trimmed away) is dropped
 * too, so the kept suffix is always a valid prompt. Zero summarization — instant, no model call.
 */
export class TokenLimiterContext implements ContextEngine {
  constructor(private readonly opts: TokenLimiterOptions) {}

  prepare(messages: ModelMessage[], ctx?: ContextPrepareCtx): ModelMessage[] {
    const est = ctx?.estimator ?? globalEstimator;
    const system = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');
    let budget = this.opts.maxTokens - totalTokens(system, est);

    const kept: ModelMessage[] = [];
    for (let i = rest.length - 1; i >= 0; i--) {
      const m = rest[i] as ModelMessage;
      const t = messageTokens(m, est);
      if (t > budget) break; // contiguous: stop at the first message that doesn't fit
      budget -= t;
      kept.unshift(m);
    }
    while (kept.length > 0 && kept[0]?.role === 'tool') kept.shift(); // strip orphan tool-results
    return [...system, ...kept];
  }
}

// ── SummarizingContextEngine (non-blocking, cache-friendly) ─────────────────────

export interface SummarizingContextOptions {
  model: ModelRouter;
  /** Model spec used for the (cheap) summarization call. */
  summaryModel: string;
  /** Optional durable store; the rolling summary is spilled here as `summary:<sessionId>`. */
  memory?: Memory;
  /** Begin a BACKGROUND compaction once non-system tokens exceed this. */
  softThresholdTokens: number;
  /** Compact SYNCHRONOUSLY (block the turn) once tokens exceed this — runaway guard. */
  hardThresholdTokens?: number;
  /** How many most-recent messages to always keep verbatim (never summarized). Default 6. */
  keepRecent?: number;
}

interface SessionState {
  /** The rolling summary text (append-only target). */
  summary?: string;
  /**
   * Observed boundary (Mastra-style): how many leading non-system messages are folded into
   * `summary` and may therefore be dropped from the sent prompt. Everything after it is sent
   * raw, so nothing summarized-but-unsent is ever lost.
   */
  coveredCount: number;
  /** A background compaction in flight for this session, if any. */
  inFlight?: Promise<void>;
}

/**
 * Compacts old turns into a rolling summary that is injected as a single system note. Compaction
 * runs in the background and does not block the agent, except past the hard threshold where it
 * runs synchronously to keep the window from overflowing. Mirrors Mastra's Observational Memory.
 *
 * The summary is folded INTO the first system message (splitSystem keeps only that one). State is
 * in-memory only (lost on restart); for durable, bounded-load history prefer
 * {@link DurableSummarizer} (history.ts), which is what the daemon uses.
 */
export class SummarizingContextEngine implements ContextEngine {
  private readonly states = new Map<string, SessionState>();
  private readonly keepRecent: number;
  private readonly hardThreshold: number;

  constructor(private readonly opts: SummarizingContextOptions) {
    this.keepRecent = opts.keepRecent ?? 6;
    this.hardThreshold = opts.hardThresholdTokens ?? Math.ceil(opts.softThresholdTokens * 1.2);
  }

  async prepare(messages: ModelMessage[], ctx: ContextPrepareCtx): Promise<ModelMessage[]> {
    const state = this.states.get(ctx.sessionId) ?? { coveredCount: 0 };
    // Touch-to-front + cap: a long-lived daemon must not accumulate state for unbounded
    // sessions. Map preserves insertion order, so re-inserting marks this session most-recent
    // and we evict the oldest once over the cap (a coarse LRU; summaries also live in Memory).
    this.states.delete(ctx.sessionId);
    this.states.set(ctx.sessionId, state);
    if (this.states.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }

    // The view we'd actually send: covered (summarized) prefix dropped, summary note injected.
    const reduced = this.withSummary(messages, state);
    const tokens = totalTokens(
      reduced.filter((m) => m.role !== 'system'),
      ctx.estimator
    );

    if (tokens < this.opts.softThresholdTokens) return reduced; // fits — nothing to do

    if (tokens >= this.hardThreshold) {
      // Runaway guard: compact synchronously so the window can't overflow this turn, then drop.
      await this.compact(messages, ctx, state);
      return this.withSummary(messages, state);
    }

    // Soft threshold: compact in the BACKGROUND (deduped per session); don't block the turn.
    // Raw messages keep being sent until the observer catches up, so nothing is lost meanwhile.
    // The compaction is deferred to a later tick so prepare() returns — and the turn proceeds —
    // before the (potentially slow) summary model call even starts. inFlight is set synchronously
    // so a second prepare() in the same tick dedupes onto this one instead of starting a duplicate.
    if (!state.inFlight) {
      state.inFlight = new Promise<void>((resolve) => {
        setTimeout(() => {
          this.compact(messages, ctx, state)
            .catch(() => {}) // a failed summary must not crash the turn or leak an unhandled rejection
            .finally(() => {
              state.inFlight = undefined;
              resolve();
            });
        }, 0);
      });
    }
    return reduced;
  }

  /**
   * Drop the observed (summarized) prefix and inject the rolling summary as one system note
   * after the real system message(s). Idempotent: a prior injected note is stripped first.
   * `coveredCount` is clamped so the last `keepRecent` messages are always kept and we never
   * drop past what the summary covers — i.e. only summarized messages are ever removed.
   */
  private withSummary(messages: ModelMessage[], state: SessionState): ModelMessage[] {
    // Strip any folded summary from system messages before re-folding below (idempotent).
    const stripped = messages.map((m) =>
      m.role === 'system' && typeof m.content === 'string'
        ? { ...m, content: m.content.split(`\n\n${SUMMARY_MARKER}`)[0] as string }
        : m
    );
    if (!state.summary) return stripped;

    const systems = stripped.filter((m) => m.role === 'system');
    const nonSystem = stripped.filter((m) => m.role !== 'system');
    const drop = Math.max(0, Math.min(state.coveredCount, nonSystem.length - this.keepRecent));
    // The drop boundary may split a structured tool-call/tool-result pair (dropping the call,
    // keeping the result). Strip leading orphan tool-results so the kept tail is a valid prompt.
    let kept = nonSystem.slice(drop);
    while (kept.length > 0 && kept[0]?.role === 'tool') kept = kept.slice(1);

    // Fold the summary INTO the first system message — splitSystem keeps only that one, so a
    // separate system note would be silently dropped before the model. Create one if absent.
    const note = `${SUMMARY_MARKER}\n${state.summary}`;
    if (systems.length === 0) return [{ role: 'system', content: note }, ...kept];
    const folded = systems.map((m, i) =>
      i === 0 && typeof m.content === 'string' ? { ...m, content: `${m.content}\n\n${note}` } : m
    );
    return [...folded, ...kept];
  }

  /** Fold the not-yet-observed older messages (before the keep-recent tail) into the summary. */
  private async compact(messages: ModelMessage[], ctx: ContextPrepareCtx, state: SessionState): Promise<void> {
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const older = nonSystem.slice(state.coveredCount, Math.max(state.coveredCount, nonSystem.length - this.keepRecent));
    if (older.length === 0) return;

    const transcript = older
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : m.content.map(partText).join(' ')}`)
      .join('\n');
    const priorSummary = state.summary ? `Previous summary:\n${state.summary}\n\n` : '';

    const result = await this.opts.model.complete({
      model: this.opts.summaryModel,
      sessionId: ctx.sessionId,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: `${priorSummary}${transcript}` }
      ]
    });

    state.summary = result.text;
    state.coveredCount += older.length; // advance the observed boundary
    await this.opts.memory?.remember(`summary:${ctx.sessionId}`, result.text);
  }
}
