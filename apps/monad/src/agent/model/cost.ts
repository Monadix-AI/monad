import type { Cost, ModelPrice, TokenUsage } from '@monad/protocol';

// ModelPrice is single-sourced in @monad/protocol (so the gateway + ai-sdk-free provider atoms
// can attach/read it too). Re-exported here for existing agent-core consumers.
export type { ModelPrice } from '@monad/protocol';

const PER_TOKEN = 1 / 1_000_000;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Real USD cost of a turn — money is NEVER inferred from estimated tokens.
 *
 *  - `provider`: the provider returned an actual cost (e.g. OpenRouter `cost`). Pass it as
 *    `providerUsd`; used verbatim, exact.
 *  - `usage×catalogPrice`: REAL token usage × a model-name-matched catalog price. The core
 *    input+output tokens must actually be reported; cache/reasoning classes add their (discounted)
 *    rates only when present (absent ⇒ 0 contribution, NOT unknown). `approximate` because the
 *    price is name-matched, though the tokens are real.
 *  - `unknown`: core tokens missing, or no usable price ⇒ `usd` undefined. We do not fabricate.
 *
 * Token semantics follow the ai-sdk normalization: `cacheReadTokens` is the cached SUBSET of
 * `inputTokens` (so non-cached input = input − cacheRead, priced cheaper); `cacheWriteTokens` is
 * additive (a one-time write surcharge). Reasoning tokens are assumed already billed inside output
 * (priced once) — revisit per provider if that proves wrong.
 */
export function computeCost(usage: TokenUsage | undefined, price: ModelPrice | undefined, providerUsd?: number): Cost {
  if (finite(providerUsd)) return { usd: providerUsd, source: 'provider', approximate: false };

  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  // Core tokens must be REAL, and we need at least input+output rates, or we don't invent a cost.
  if (!price || !finite(input) || !finite(output) || !finite(price.input) || !finite(price.output)) {
    return { source: 'unknown', approximate: true };
  }

  const cacheRead = finite(usage?.cacheReadTokens) ? (usage?.cacheReadTokens as number) : 0;
  const cacheWrite = finite(usage?.cacheWriteTokens) ? (usage?.cacheWriteTokens as number) : 0;
  const nonCachedInput = Math.max(0, input - cacheRead);

  const usd =
    PER_TOKEN *
    (nonCachedInput * price.input +
      cacheRead * (finite(price.cacheRead) ? price.cacheRead : price.input) + // no cache-read rate → input rate (conservative)
      cacheWrite * (finite(price.cacheWrite) ? price.cacheWrite : price.input) +
      output * price.output);

  return { usd, source: 'catalog_price', approximate: true };
}
