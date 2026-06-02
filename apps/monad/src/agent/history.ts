// Durable, bounded-load history assembly (the "B" strategy). Instead of loading the WHOLE
// transcript every turn and trimming it down, the agent loads only the messages SINCE a durable
// summarization boundary, plus a durable rolling summary of everything before it. Both the
// summary and the boundary (a message id) are persisted via a SummaryStore, so per-turn DB read
// and memory stay O(window) regardless of total session length — and survive restarts.
//
// The summary is returned SEPARATELY (not as a message) so the loop can fold it into the single
// system prompt: splitSystem keeps only the first system message, so a second one would be
// silently dropped before reaching the model.

import type { ChatMessage } from './loop/index.ts';
import type { ModelMessage, ModelRouter } from './model/index.ts';

import { z } from 'zod';

import { estimateTokens } from './context/estimate.ts';
import { messageTokens } from './context/index.ts';
import { replayHistory } from './loop/index.ts';
import {
  renderSummaryReflectUserPrompt,
  renderSummaryStructuredSystemPrompt,
  renderSummaryUserPrompt,
  SUMMARY_REFLECT_PROMPT
} from './prompts.ts';

/** Cap on how much of a single tool-call input / tool-result output is fed to the summarizer, so a
 *  giant file dump doesn't blow up the summary prompt while its head still names the file/symbol. */
const SUMMARY_PART_CHARS = 800;

// A tool-result's full pre-truncation bytes are (usually) recoverable by handle via
// read_tool_output — see AgentLoopDeps.persistRawToolOutput / ToolResultEvictionContext. The
// summarizer therefore only needs a head preview to name the file/symbol involved, not a
// faithfully-balanced head+tail: the handle is the fidelity backstop, this is just a pointer.
function truncateForSummary(s: string, handle?: string): string {
  if (s.length <= SUMMARY_PART_CHARS) return s;
  const recover = handle
    ? `read_tool_output({ id: "${handle}" }) for the rest`
    : `${s.length - SUMMARY_PART_CHARS} more chars`;
  return `${s.slice(0, SUMMARY_PART_CHARS)}… [${recover}]`;
}

/** Render a message's content for the summarizer, surfacing tool names + (truncated) inputs/outputs
 *  so the structured summary can cite the exact files, symbols, and commands involved — rather than
 *  collapsing every tool step to an opaque placeholder. */
function renderForSummary(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => {
      switch (p.type) {
        case 'text':
          return p.text;
        case 'tool-call':
          return `[tool-call ${p.toolName} ${truncateForSummary(JSON.stringify(p.input))}]`;
        case 'tool-result':
          return `[tool-result ${p.toolName} ${truncateForSummary(p.output, p.toolCallId)}]`;
        default:
          return '[image]';
      }
    })
    .join(' ');
}

/** Render messages the way the summarizer sees them — shared so afterCompact's `foldedText` matches
 *  exactly what fed the summarization call, not a re-derivation that could drift from it. */
function renderTranscript(messages: ModelMessage[]): string {
  return messages.map((m) => `${m.role}: ${renderForSummary(m.content)}`).join('\n');
}

/** What a HistoryProvider produces for a turn: the recent messages + an optional rolling summary. */
export interface AssembledHistory {
  /** Durable summary of older turns. The loop folds this into the system prompt, not as a message. */
  summary?: string;
  /** Replayed recent messages (since the boundary); no summary message included. */
  messages: ModelMessage[];
}

/** Produces the turn's history. Default loop behaviour (full load + replay) is the implicit one;
 *  a provider lets the daemon swap in a bounded-load strategy. */
export interface HistoryProvider {
  assemble(sessionId: string): Promise<AssembledHistory>;
}

/** Message access the DurableSummarizer needs: full history (first compaction) + an after-cursor. */
interface MessageSource {
  list(sessionId: string): ChatMessage[] | Promise<ChatMessage[]>;
  /** Messages strictly after `afterMessageId`, chronological. */
  listSince(sessionId: string, afterMessageId: string): ChatMessage[] | Promise<ChatMessage[]>;
}

// Schema-first: this record is persisted to disk via SummaryStore, so it is parsed (not cast)
// on load — a corrupt/partial file must fail closed, not surface as a malformed DurableSummary.
const durableSummarySchema = z.object({
  summary: z.string(),
  /** Boundary: messages with id ≤ this are folded into `summary`; load strictly after it. */
  uptoMessageId: z.string()
});
export type DurableSummary = z.infer<typeof durableSummarySchema>;

export function parseDurableSummary(value: string | null | undefined): DurableSummary | null {
  if (!value) return null;
  try {
    const parsed = durableSummarySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Durable per-session store for the rolling summary + boundary (daemon backs it with @monad/store). */
export interface SummaryStore {
  load(sessionId: string): DurableSummary | null | Promise<DurableSummary | null>;
  save(sessionId: string, rec: DurableSummary): void | Promise<void>;
}

export interface DurableSummarizerOptions {
  messages: MessageSource;
  summaryStore: SummaryStore;
  model: ModelRouter;
  /** Cheap model spec for the summarization call. */
  summaryModel: string;
  /** Compact once the loaded window's tokens exceed this. In `background` mode this triggers a
   *  non-blocking compaction; in synchronous mode it compacts inline. */
  softThresholdTokens: number;
  /** `background` mode only: once the loaded window exceeds this, compact SYNCHRONOUSLY at turn start
   *  (blocking) rather than in the background — the window is too full to safely send another turn
   *  first. Default Infinity (never force-sync; rely on the loop's per-step TokenLimiter backstop). */
  hardThresholdTokens?: number;
  /** When true, soft-threshold compaction runs in the BACKGROUND (Mastra-style): the turn proceeds
   *  with the full window and the compacted result lands whenever it finishes (a later turn). A turn
   *  that starts at/over `hardThresholdTokens` waits for any in-flight compaction, then compacts
   *  synchronously if still over. Default false — compact synchronously at the soft threshold. */
  background?: boolean;
  /** Most-recent messages always kept verbatim (never summarized). Default 8. */
  keepRecent?: number;
  /** Condense (GC) the rolling summary once it exceeds this many tokens. Default 4000. */
  reflectThresholdTokens?: number;
  /** Fired right before a compaction summarizes old turns (the PreCompact lifecycle event). Returns
   *  "preserve this" instructions to fold into the summarization prompt so a hook can protect details
   *  that lossy compaction would otherwise drop. Must not throw — wire it to swallow hook failures. */
  preCompact?: (info: { sessionId: string; trigger: 'soft' | 'manual'; tokens: number }) => Promise<string[]>;
  /** Fired right after a compaction commits (the AfterCompact lifecycle event). Observe-only;
   *  must not throw. `foldedText` is the rendered transcript of exactly what got folded into the
   *  summary this pass — the source for memory-promotion extraction, since the summary itself is
   *  already lossy/paraphrased. */
  afterCompact?: (info: { sessionId: string; trigger: 'soft' | 'manual'; tokens: number; foldedText: string }) => void;
}

/** Backstop cap on per-session background-compaction state held by the long-lived summarizer. */
const MAX_TRACKED_SESSIONS = 1000;

/** The loaded window for a turn: rows since the boundary, their replay, the carried summary, tokens. */
interface Window {
  rows: ChatMessage[];
  replayed: ModelMessage[];
  summary?: string;
  tokens: number;
}

/**
 * HistoryProvider that keeps per-turn load bounded by folding old turns into a durable summary
 * and only loading messages since the summary boundary. The summary + boundary persist across turns
 * and restarts, and everything is a pure projection of the immutable message store: the raw rows,
 * the rolling summary (+ its boundary cursor), and the per-turn sent window can each be recomputed,
 * replayed, and recovered independently — so a branch taken before the boundary restores from the
 * raw rows, and the UI can render raw messages, the summary note, and the sent window separately.
 *
 * Compaction is synchronous by default; in `background` mode it is Mastra-style non-blocking (soft
 * threshold kicks a background job whose result lands on a later turn; the hard threshold blocks,
 * waiting for any in-flight job first). At most one compaction per session runs at a time.
 */
export class DurableSummarizer implements HistoryProvider {
  private readonly keepRecent: number;
  private readonly background: boolean;
  private readonly hardThreshold: number;
  /** Per-session background-compaction state (in-flight promise), coarse-LRU capped. */
  private readonly states = new Map<string, { inFlight?: Promise<void> }>();

  constructor(private readonly opts: DurableSummarizerOptions) {
    this.keepRecent = opts.keepRecent ?? 8;
    this.background = opts.background ?? false;
    this.hardThreshold = opts.hardThresholdTokens ?? Number.POSITIVE_INFINITY;
  }

  /** True while a background compaction for this session is running (for the loop/UI to surface). */
  pendingCompaction(sessionId: string): boolean {
    return this.states.get(sessionId)?.inFlight !== undefined;
  }

  async assemble(sessionId: string): Promise<AssembledHistory> {
    let w = await this.loadWindow(sessionId);
    const compactable = w.rows.length > this.keepRecent;

    if (this.background) {
      const st = this.state(sessionId);
      // At/over the hard threshold with a background compaction in flight → wait for it to shrink the
      // window, then reload (the boundary has advanced).
      if (w.tokens >= this.hardThreshold && st.inFlight) {
        await st.inFlight;
        w = await this.loadWindow(sessionId);
      }
      // Still over hard → compact synchronously; we can't safely send an over-budget window.
      if (w.tokens >= this.hardThreshold && w.rows.length > this.keepRecent) {
        return await this.compactNow(sessionId, w);
      }
      // Soft: compact in the background (deduped per session). The turn proceeds with the full window;
      // the compacted result is picked up by whichever later turn runs after it commits.
      if (w.tokens >= this.opts.softThresholdTokens && compactable) this.kickBackground(sessionId, w);
      return { summary: w.summary, messages: w.replayed };
    }

    // Synchronous (default): fold older rows inline at the soft threshold.
    if (w.tokens >= this.opts.softThresholdTokens && compactable) {
      return await this.compactNow(sessionId, w);
    }

    return { summary: w.summary, messages: w.replayed };
  }

  /** Load the bounded window for a turn: rows since the durable boundary, their replay + token size,
   *  and the carried summary. Pure read — the single source both assemble and background compaction
   *  project from. */
  private async loadWindow(sessionId: string): Promise<Window> {
    const rec = await this.opts.summaryStore.load(sessionId);
    const rows = rec
      ? await this.opts.messages.listSince(sessionId, rec.uptoMessageId)
      : await this.opts.messages.list(sessionId);
    const replayed = replayHistory(rows);
    const tokens = replayed.reduce((sum, m) => sum + messageTokens(m), 0);
    return { rows, replayed, summary: rec?.summary, tokens };
  }

  /** Fold the loaded window's older rows into the durable summary, advance the boundary, and return
   *  the recent tail to send. Shared by the synchronous, hard-sync, and background paths. */
  private async compactNow(sessionId: string, w: Window): Promise<AssembledHistory> {
    const olderRows = w.rows.slice(0, w.rows.length - this.keepRecent);
    if (olderRows.length === 0) return { summary: w.summary, messages: w.replayed };
    const boundaryId = (olderRows[olderRows.length - 1] as ChatMessage).id;
    const preserve = (await this.opts.preCompact?.({ sessionId, trigger: 'soft', tokens: w.tokens })) ?? [];
    const olderMessages = replayHistory(olderRows);
    let summary = await this.summarize(w.summary, olderMessages, sessionId, preserve);
    summary = await this.reflectIfNeeded(summary, sessionId);
    await this.opts.summaryStore.save(sessionId, { summary, uptoMessageId: boundaryId });
    this.opts.afterCompact?.({
      sessionId,
      trigger: 'soft',
      tokens: w.tokens,
      foldedText: renderTranscript(olderMessages)
    });
    // Sent window is the recent tail; older turns are folded into `summary`.
    return { summary, messages: replayHistory(w.rows.slice(w.rows.length - this.keepRecent)) };
  }

  /** Start a background compaction for this session unless one is already running (dedup). The turn
   *  returning meanwhile keeps sending the full window; the result is durable and lands on a later turn.
   *  A failed background summary must never crash a turn — errors are swallowed. */
  private kickBackground(sessionId: string, w: Window): void {
    const st = this.state(sessionId);
    if (st.inFlight) return;
    st.inFlight = this.compactNow(sessionId, w)
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        st.inFlight = undefined;
      });
  }

  /** Per-session state with a coarse LRU cap so a long-lived daemon can't accumulate state for
   *  unbounded sessions (re-inserting marks this session most-recent). */
  private state(sessionId: string): { inFlight?: Promise<void> } {
    const existing = this.states.get(sessionId) ?? {};
    this.states.delete(sessionId);
    this.states.set(sessionId, existing);
    if (this.states.size > MAX_TRACKED_SESSIONS) {
      // Evict the oldest IDLE session. Dropping an entry with a live `inFlight` would let the next
      // assemble start a duplicate compaction (its dedup guard is gone) — two concurrent saves race
      // the boundary and silently lose a summarized span. If every tracked session is mid-compaction
      // (bounded by the concurrency cap), skip eviction this round.
      for (const [sid, st] of this.states) {
        if (!st.inFlight) {
          this.states.delete(sid);
          break;
        }
      }
    }
    return existing;
  }

  /** Force a compaction NOW (the `/compact` command), regardless of the soft threshold: fold the full
   *  loaded window into the durable summary and advance the boundary. Returns how many stored rows
   *  were folded (0 → no loaded rows, a no-op). */
  async compact(sessionId: string): Promise<{ compacted: number; summary?: string }> {
    await this.states.get(sessionId)?.inFlight; // don't race an in-flight background compaction
    const rec = await this.opts.summaryStore.load(sessionId);
    const rows = rec
      ? await this.opts.messages.listSince(sessionId, rec.uptoMessageId)
      : await this.opts.messages.list(sessionId);
    if (rows.length === 0) return { compacted: 0 };
    const boundaryId = (rows[rows.length - 1] as ChatMessage).id;
    // Replay the rows being compacted ONCE — reused for the PreCompact token metric and the summary.
    const replayed = replayHistory(rows);
    const tokens = replayed.reduce((sum, m) => sum + messageTokens(m), 0);
    const preserve = (await this.opts.preCompact?.({ sessionId, trigger: 'manual', tokens })) ?? [];
    let summary = await this.summarize(rec?.summary, replayed, sessionId, preserve);
    summary = await this.reflectIfNeeded(summary, sessionId);
    await this.opts.summaryStore.save(sessionId, { summary, uptoMessageId: boundaryId });
    this.opts.afterCompact?.({ sessionId, trigger: 'manual', tokens, foldedText: renderTranscript(replayed) });
    return { compacted: rows.length, summary };
  }

  /** GC the rolling summary when it has grown past the reflect threshold (Mastra reflector). */
  private async reflectIfNeeded(summary: string, sessionId: string): Promise<string> {
    const cap = this.opts.reflectThresholdTokens ?? 4000;
    if (estimateTokens(summary) <= cap) return summary;
    const result = await this.opts.model.complete({
      model: this.opts.summaryModel,
      sessionId,
      messages: [
        { role: 'system', content: SUMMARY_REFLECT_PROMPT },
        { role: 'user', content: renderSummaryReflectUserPrompt(summary) }
      ]
    });
    return result.text;
  }

  private async summarize(
    prior: string | undefined,
    older: ModelMessage[],
    sessionId: string,
    preserve: string[] = []
  ): Promise<string> {
    const transcript = renderTranscript(older);
    const result = await this.opts.model.complete({
      model: this.opts.summaryModel,
      sessionId,
      messages: [
        { role: 'system', content: renderSummaryStructuredSystemPrompt(preserve) },
        { role: 'user', content: renderSummaryUserPrompt({ prior, transcript }) }
      ]
    });
    return result.text;
  }
}
