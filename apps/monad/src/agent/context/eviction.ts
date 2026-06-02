// ToolResultEvictionContext — the lossless first stage of the context cascade.
//
// Tool results (file reads, command output, search dumps) dominate a long agent transcript and go
// stale fast: once the model has acted on a `read_file`, the raw bytes rarely matter again. Before
// the window gets tight enough to warrant a LOSSY summary, this engine reclaims that space losslessly
// by replacing the `output` of OLD tool-result parts with a short pointer placeholder — the model can
// always re-run the tool to get the bytes back. The tool-call/tool-result pairing is preserved (only
// the output text changes, no message is dropped), so strict providers never see an orphaned pair.
//
// It only fires when the window is genuinely filling (`atFraction` of the limit) AND enough is
// reclaimable in one pass (`clearAtLeast`) to be worth the loss — so a mostly-empty window is never
// touched, and eviction happens in meaningful batches rather than one result at a time.
//
// Recency is measured in ROUNDS, not individual results. A round is one assistant→tools step; a step
// with parallel tool calls lands all its results in one `tool` message (same age). Protecting the
// last `keepRecentRounds` rounds keeps each recent step whole regardless of how many concurrent
// results it produced — a flat "keep N results" count would protect only the current burst and could
// even split one concurrent batch (evict some parallel results while keeping their same-age siblings).

import type { SessionId } from '@monad/protocol';
import type { ModelContentPart, ModelMessage } from '../model/index.ts';

import { makeEvent } from '#/services/event-bus.ts';
import { evictedToolResult } from '../prompts.ts';
import { globalEstimator, type TokenEstimator } from './estimate.ts';
import { type ContextEngine, type ContextPrepareCtx, effectiveInputTokens } from './index.ts';

export interface ToolResultEvictionOptions {
  /** The model's context window in tokens; thresholds are fractions of it. */
  contextLimit: number;
  /** Begin evicting once window occupancy crosses this fraction of the limit. Default 0.5. */
  atFraction?: number;
  /** Always keep the N most-recent tool ROUNDS verbatim (a round = one assistant→tools step, kept
   *  whole even if it fired many parallel calls). Never evicted. Default 3. */
  keepRecentRounds?: number;
  /** Only bother when a single pass can reclaim at least this many tokens. Default 2000. */
  clearAtLeast?: number;
  /** Skip results smaller than this (not worth a placeholder). Default 200. */
  minResultTokens?: number;
  /** Spill an evicted result's full output before replacing it with a placeholder — covers results
   *  that were NEVER truncated at tool-execution time (short enough to send whole) and so were never
   *  spilled there. Without this, evicting one of those loses the bytes for good (no read_tool_output
   *  handle exists). Same seam as AgentLoopDeps.persistRawToolOutput. Absent → eviction stays
   *  recoverable only via re-running the tool. */
  persistRawOutput?: (sessionId: string, toolCallId: string, output: string) => void;
  /** True when a raw output is already spilled for this toolCallId. Gates `persistRawOutput` above —
   *  a result long enough to have been truncated at tool-execution time was already spilled there
   *  with the ORIGINAL full bytes; by eviction time `r.output` is that same tool call's PERSISTED
   *  (already-truncated) text, since replay reconstructs it from the stored row. Spilling
   *  unconditionally would overwrite the correct full-text entry with the truncated one — silently
   *  corrupting the recovery handle for exactly the large results most likely to need it. Absent →
   *  always spills (matches the pre-this-check behavior; only correct when nothing is ever truncated
   *  at execution time, e.g. persistRawOutput itself is also absent). */
  hasRawOutput?: (sessionId: string, toolCallId: string) => boolean;
}

/** Leading marker on every placeholder, used to detect already-evicted results idempotently. */
export const EVICTED_MARKER = '[context-cleared]';

/** Backstop cap on per-session cumulative stats held by a long-lived engine instance. */
const MAX_TRACKED_SESSIONS = 1000;

/** True once a tool-result output is already a pointer placeholder — never re-evict it. */
function isEvicted(output: string): boolean {
  return output.startsWith(EVICTED_MARKER);
}

interface ResultRef {
  msgIndex: number;
  partIndex: number;
  toolCallId: string;
  toolName: string;
  output: string;
  tokens: number;
  /** Which tool round this result belongs to (one assistant→tools step). Protection is per-round. */
  round: number;
}

export class ToolResultEvictionContext implements ContextEngine {
  private readonly atFraction: number;
  private readonly keepRecentRounds: number;
  private readonly clearAtLeast: number;
  private readonly minResultTokens: number;
  // Cumulative tokens reclaimed per session across the process lifetime — the running total the
  // 'evicted' context.usage bucket reports (placeholders keep occupying window space forever, so
  // this only grows). Touch-to-front + capped like SummarizingContextEngine's session map.
  private readonly reclaimed = new Map<string, number>();

  constructor(private readonly opts: ToolResultEvictionOptions) {
    this.atFraction = opts.atFraction ?? 0.5;
    this.keepRecentRounds = opts.keepRecentRounds ?? 3;
    this.clearAtLeast = opts.clearAtLeast ?? 2000;
    this.minResultTokens = opts.minResultTokens ?? 200;
  }

  /** Cumulative tokens reclaimed for this session so far (0 if it never triggered). */
  reclaimedTokens(sessionId: string): number {
    return this.reclaimed.get(sessionId) ?? 0;
  }

  prepare(messages: ModelMessage[], ctx?: ContextPrepareCtx): ModelMessage[] {
    const est = ctx?.estimator ?? globalEstimator;
    const trigger = Math.floor(this.opts.contextLimit * this.atFraction);
    if (effectiveInputTokens(messages, ctx, est) < trigger) return messages; // window not tight yet

    // Every tool-result tagged with its round; protect the most recent `keepRecentRounds` rounds
    // (whole steps, concurrency-width-independent), evict older rounds' results.
    const results = this.collectResults(messages, est);
    if (results.length === 0) return messages;
    const roundsWithResults = [...new Set(results.map((r) => r.round))].sort((a, b) => a - b);
    // slice(-0) would be slice(0) (the WHOLE array) — protect nothing when keepRecentRounds is 0.
    const protectedRounds = new Set(this.keepRecentRounds > 0 ? roundsWithResults.slice(-this.keepRecentRounds) : []);

    const candidates = results.filter(
      (r) => !protectedRounds.has(r.round) && !isEvicted(r.output) && r.tokens >= this.minResultTokens
    );
    const reclaimable = candidates.reduce((sum, r) => sum + r.tokens, 0);
    if (reclaimable < this.clearAtLeast) return messages; // not enough to justify the loss this pass

    // Spill each candidate's full output BEFORE it's overwritten below — this covers results that
    // were never truncated at tool-execution time (short enough to send whole) and so were never
    // spilled there. Without this a short-but-old result would lose its bytes for good on eviction.
    // A result that WAS truncated at execution time was already spilled there with the ORIGINAL full
    // bytes — by now `r.output` is that same call's PERSISTED (already-truncated) text (replay
    // reconstructs it from the stored row), so spilling it here would silently overwrite the correct
    // entry with the truncated one. `hasRawOutput` lets us skip re-spilling those — a handle exists
    // either way, so the placeholder still promises one.
    const persist = this.opts.persistRawOutput;
    const sessionId = ctx?.sessionId;
    const hasRaw = this.opts.hasRawOutput;
    const hasHandle = new Set<string>();
    if (persist && sessionId) {
      for (const r of candidates) {
        if (!(hasRaw?.(sessionId, r.toolCallId) ?? false)) persist(sessionId, r.toolCallId, r.output);
        hasHandle.add(r.toolCallId);
      }
    }

    // Rewrite only the affected messages, cloning so cached history objects are never mutated.
    const evictParts = new Map<string, string>();
    for (const r of candidates) evictParts.set(`${r.msgIndex}:${r.partIndex}`, r.toolCallId);

    const out = messages.map((m, i) => {
      if (!Array.isArray(m.content)) return m;
      let changed = false;
      const content = m.content.map((p, j) => {
        const toolCallId = evictParts.get(`${i}:${j}`);
        if (toolCallId === undefined || p.type !== 'tool-result') return p;
        changed = true;
        return {
          ...p,
          output: `${EVICTED_MARKER} ${evictedToolResult(p.toolName, hasHandle.has(toolCallId) ? toolCallId : undefined)}`
        };
      });
      return changed ? { ...m, content } : m;
    });

    if (sessionId) {
      const prior = this.reclaimedTokens(sessionId);
      this.reclaimed.delete(sessionId); // touch-to-front
      this.reclaimed.set(sessionId, prior + reclaimable);
      if (this.reclaimed.size > MAX_TRACKED_SESSIONS) {
        const oldest = this.reclaimed.keys().next().value;
        if (oldest !== undefined) this.reclaimed.delete(oldest);
      }
      ctx?.emit(
        makeEvent(sessionId as SessionId, 'context.evicted', {
          reclaimedTokens: reclaimable,
          resultCount: candidates.length
        })
      );
    }
    return out;
  }

  /** Every tool-result part across all messages, in transcript order, tagged with its round and
   *  estimated size. A round advances on each assistant message that carries tool-calls, so all of a
   *  concurrent step's results (grouped into one `tool` message) share one round. */
  private collectResults(messages: ModelMessage[], est: TokenEstimator): ResultRef[] {
    const out: ResultRef[] = [];
    let round = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const content = m?.content;
      if (!Array.isArray(content)) continue;
      if (m?.role === 'assistant' && content.some((p) => p.type === 'tool-call')) round++;
      for (let j = 0; j < content.length; j++) {
        const p = content[j] as ModelContentPart;
        if (p.type !== 'tool-result') continue;
        out.push({
          msgIndex: i,
          partIndex: j,
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          output: p.output,
          tokens: est.fromChars(p.output.length),
          round
        });
      }
    }
    return out;
  }
}
