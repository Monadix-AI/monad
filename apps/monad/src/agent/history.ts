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
import { SUMMARY_PROMPT, SUMMARY_REFLECT_PROMPT } from './prompts.ts';

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
  /** Compact once the loaded window's tokens exceed this. */
  softThresholdTokens: number;
  /** Most-recent messages always kept verbatim (never summarized). Default 8. */
  keepRecent?: number;
  /** Condense (GC) the rolling summary once it exceeds this many tokens. Default 4000. */
  reflectThresholdTokens?: number;
  /** Fired right before a compaction summarizes old turns (the PreCompact lifecycle event). Returns
   *  "preserve this" instructions to fold into the summarization prompt so a hook can protect details
   *  that lossy compaction would otherwise drop. Must not throw — wire it to swallow hook failures. */
  preCompact?: (info: { sessionId: string; trigger: 'soft' | 'manual'; tokens: number }) => Promise<string[]>;
  /** Fired right after a compaction commits (the AfterCompact lifecycle event). Observe-only;
   *  must not throw. */
  afterCompact?: (info: { sessionId: string; trigger: 'soft' | 'manual'; tokens: number }) => void;
}

/**
 * HistoryProvider that keeps per-turn load bounded by folding old turns into a durable summary
 * and only loading messages since the summary boundary. Compacts at most once per turn (the
 * loop's per-step TokenLimiter is the in-turn guard); the summary + boundary persist across turns
 * and restarts.
 */
export class DurableSummarizer implements HistoryProvider {
  private readonly keepRecent: number;

  constructor(private readonly opts: DurableSummarizerOptions) {
    this.keepRecent = opts.keepRecent ?? 8;
  }

  async assemble(sessionId: string): Promise<AssembledHistory> {
    const rec = await this.opts.summaryStore.load(sessionId);
    const rows = rec
      ? await this.opts.messages.listSince(sessionId, rec.uptoMessageId)
      : await this.opts.messages.list(sessionId);

    const replayed = replayHistory(rows);
    let summary = rec?.summary;

    const windowTokens = replayed.reduce((sum, m) => sum + messageTokens(m), 0);
    if (windowTokens >= this.opts.softThresholdTokens && rows.length > this.keepRecent) {
      const olderRows = rows.slice(0, rows.length - this.keepRecent);
      const boundaryId = (olderRows[olderRows.length - 1] as ChatMessage).id;
      const preserve = (await this.opts.preCompact?.({ sessionId, trigger: 'soft', tokens: windowTokens })) ?? [];
      summary = await this.summarize(summary, replayHistory(olderRows), sessionId, preserve);
      summary = await this.reflectIfNeeded(summary, sessionId);
      await this.opts.summaryStore.save(sessionId, { summary, uptoMessageId: boundaryId });
      this.opts.afterCompact?.({ sessionId, trigger: 'soft', tokens: windowTokens });
      // Sent window is the recent tail; older turns are folded into `summary`.
      return { summary, messages: replayHistory(rows.slice(rows.length - this.keepRecent)) };
    }

    return { summary, messages: replayed };
  }

  /** Force a compaction NOW (the `/compact` command), regardless of the soft threshold: fold the full
   *  loaded window into the durable summary and advance the boundary. Returns how many stored rows
   *  were folded (0 → no loaded rows, a no-op). */
  async compact(sessionId: string): Promise<{ compacted: number; summary?: string }> {
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
    this.opts.afterCompact?.({ sessionId, trigger: 'manual', tokens });
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
        { role: 'user', content: summary }
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
    const transcript = older
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[structured tool step]'}`)
      .join('\n');
    const priorBlock = prior ? `Previous summary:\n${prior}\n\n` : '';
    // PreCompact hooks can demand certain details survive compaction — append them to the system
    // instruction so the summarizer treats them as must-keep rather than summarizable.
    const system = preserve.length
      ? `${SUMMARY_PROMPT}\n\nPreserve these details verbatim if they appear in the transcript:\n${preserve.map((p) => `- ${p}`).join('\n')}`
      : SUMMARY_PROMPT;
    const result = await this.opts.model.complete({
      model: this.opts.summaryModel,
      sessionId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${priorBlock}${transcript}` }
      ]
    });
    return result.text;
  }
}
