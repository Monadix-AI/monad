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

import type { ModelContentPart, ModelMessage } from '../model/index.ts';

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
}

/** Leading marker on every placeholder, used to detect already-evicted results idempotently. */
export const EVICTED_MARKER = '[context-cleared]';

/** True once a tool-result output is already a pointer placeholder — never re-evict it. */
function isEvicted(output: string): boolean {
  return output.startsWith(EVICTED_MARKER);
}

interface ResultRef {
  msgIndex: number;
  partIndex: number;
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

  constructor(private readonly opts: ToolResultEvictionOptions) {
    this.atFraction = opts.atFraction ?? 0.5;
    this.keepRecentRounds = opts.keepRecentRounds ?? 3;
    this.clearAtLeast = opts.clearAtLeast ?? 2000;
    this.minResultTokens = opts.minResultTokens ?? 200;
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

    // Rewrite only the affected messages, cloning so cached history objects are never mutated.
    const evictParts = new Map<number, Set<number>>();
    for (const r of candidates) {
      const parts = evictParts.get(r.msgIndex) ?? new Set<number>();
      parts.add(r.partIndex);
      evictParts.set(r.msgIndex, parts);
    }

    return messages.map((m, i) => {
      const parts = evictParts.get(i);
      if (!parts || !Array.isArray(m.content)) return m;
      const content = m.content.map((p, j) =>
        parts.has(j) && p.type === 'tool-result'
          ? { ...p, output: `${EVICTED_MARKER} ${evictedToolResult(p.toolName)}` }
          : p
      );
      return { ...m, content };
    });
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
