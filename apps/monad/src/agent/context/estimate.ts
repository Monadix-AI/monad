// Network-free token estimation with NO local tokenizer. A bundled BPE table (gpt-tokenizer's
// o200k_base) cost ~200 MB RSS for too little gain; exact counts should come from the provider,
// not a shipped tokenizer. Instead: a self-calibrating chars-per-token ratio,
// learned from the provider's real reported usage. `tokens ≈ ceil(chars / ratio)`.
//
// Provider-reported token totals stay authoritative wherever they exist; this only fills the
// per-segment context-window split and the compaction thresholds — all explicitly approximate,
// never the cumulative consumption ledger or cost (those are real-only).

const DEFAULT_RATIO = 4; // chars per token — English-ish seed, used until a real sample arrives
const MIN_RATIO = 2; // dense (CJK / code / base64) — clamp so a freak sample can't skew us
const MAX_RATIO = 8; // sparse (whitespace-heavy)
const EMA_ALPHA = 0.3; // weight of each new sample in the running ratio

function clampRatio(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** A chars-per-token estimator that self-calibrates from the provider's real reported usage. */
export class TokenEstimator {
  private r: number;
  private calibrated = false;

  constructor(seed: number = DEFAULT_RATIO) {
    this.r = clampRatio(seed);
  }

  /** Current chars-per-token ratio. */
  get ratio(): number {
    return this.r;
  }

  /** True until at least one real (chars, tokens) sample has been observed. */
  get approximate(): boolean {
    return !this.calibrated;
  }

  estimate(text: string): number {
    return text ? Math.ceil(text.length / this.r) : 0;
  }

  fromChars(chars: number): number {
    return chars > 0 ? Math.ceil(chars / this.r) : 0;
  }

  /**
   * Feed a real sample: the chars actually sent this turn + the provider's reported input tokens.
   * Only meaningful values move the ratio (presence ≠ value — a missing/zero usage is ignored).
   */
  observe(chars: number, tokens: number | undefined): void {
    if (!(chars > 0) || !(typeof tokens === 'number' && tokens > 0)) return;
    const sample = clampRatio(chars / tokens);
    this.r = this.calibrated ? EMA_ALPHA * sample + (1 - EMA_ALPHA) * this.r : sample;
    this.calibrated = true;
  }
}

/** Process-wide estimator backing the module helpers and warm-seeding new per-session ones. */
export const globalEstimator = new TokenEstimator();

/** Module-level estimate via the global estimator (drop-in for the old tokenize.ts API). */
export function estimateTokens(text: string): number {
  return globalEstimator.estimate(text);
}

// Cache the immutable CHAR LENGTH per key, then apply the CURRENT ratio at read time — so a
// mutating ratio never staleens the cache, while still avoiding O(turns²) re-measurement.
const charCache = new Map<string, number>();
const CHAR_CACHE_CAP = 50_000;

/** `estimateTokens(text)` memoized by a stable key whose text never changes (e.g. a message id). */
export function estimateTokensCached(key: string, text: string): number {
  let chars = charCache.get(key);
  if (chars === undefined) {
    chars = text.length;
    if (charCache.size >= CHAR_CACHE_CAP) charCache.clear(); // coarse backstop against unbounded growth
    charCache.set(key, chars);
  }
  return globalEstimator.fromChars(chars);
}
