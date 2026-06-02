// Attributes the context window to functional categories (system prompt, tools, skills,
// memory, messages, …) so a client can render the `/context` breakdown.
// Itemize as the prompt is assembled, then group by category at render time. For the
// messages bucket, prefer the provider's returned usage as ground truth (pass it as
// `usedMessageTokens`); everything else is locally estimated. See ./tokenize.ts.

import type { ContextCategory, ContextSegment, ContextUsagePayload } from '@monad/protocol';

import { globalEstimator, type TokenEstimator } from './estimate.ts';

/** Headroom reserved before auto-compaction triggers. */
export const DEFAULT_AUTOCOMPACT_BUFFER = 16_000;

export interface ContextUsageOptions {
  contextLimit: number;
  autocompactBuffer?: number;
  /** True when any segment was locally estimated (no exact provider tokenizer). Default true. */
  approximate?: boolean;
  /** Cumulative tokens reclaimed by lossless tool-result eviction so far — informational, not
   *  summed into `used`/`free` (those already reflect the post-eviction, shrunk prompt). */
  reclaimed?: number;
}

/** Sum segments, group nothing (the client groups), and compute used/free against the limit. */
export function buildContextUsage(segments: ContextSegment[], opts: ContextUsageOptions): ContextUsagePayload {
  const autocompactBuffer = opts.autocompactBuffer ?? DEFAULT_AUTOCOMPACT_BUFFER;
  const used = segments.reduce((sum, s) => sum + s.tokens, 0);
  const free = Math.max(0, opts.contextLimit - used - autocompactBuffer);
  return {
    contextLimit: opts.contextLimit,
    used,
    free,
    autocompactBuffer,
    approximate: opts.approximate ?? true,
    segments,
    ...(opts.reclaimed ? { reclaimed: opts.reclaimed } : {})
  };
}

/**
 * Accumulates itemized context segments. `add` estimates tokens from text; `addTokens` takes
 * a known count (e.g. provider usage for the messages bucket). Zero-token segments are
 * dropped so the breakdown stays clean.
 */
export class ContextBuilder {
  private readonly segments: ContextSegment[] = [];

  /** `est` is the per-session estimator (self-calibrating char ratio); defaults to the global one. */
  constructor(private readonly est: TokenEstimator = globalEstimator) {}

  add(category: ContextCategory, label: string, text: string): this {
    return this.addTokens(category, label, this.est.estimate(text));
  }

  addTokens(category: ContextCategory, label: string, tokens: number): this {
    if (tokens > 0) this.segments.push({ category, label, tokens });
    return this;
  }

  list(): ContextSegment[] {
    return this.segments.slice();
  }

  build(opts: ContextUsageOptions): ContextUsagePayload {
    return buildContextUsage(this.segments, opts);
  }
}
