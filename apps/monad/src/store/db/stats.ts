// Global usage ledger + pre-aggregated dashboard stats. Split out of index.ts: this is the
// analytics concern (billing ledger, streaks, model share), independent of session/message CRUD.
// Every function takes the raw bun:sqlite handle — the ledger uses parameterized raw SQL (upserts,
// window-free aggregates) rather than drizzle, so it stays here as free functions the Store delegates to.

import type { Database } from 'bun:sqlite';
import type { DayBucket, GetStatsResponse, LedgerCategory, ModelShare, StatsRange, TokenUsage } from '@monad/protocol';

import { localDay } from './row-mappers.ts';

/** Cumulative usage per (provider, model), aggregated across all days + categories. */
export interface LedgerEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  updatedAt: string;
}

/** One fully-dimensioned ledger row (local day × provider × model × category). */
export interface LedgerBreakdownRow extends LedgerEntry {
  day: string;
  category: LedgerCategory;
}

/** Accumulate one operation into the GLOBAL ledger, bucketed by (local day, provider, model,
 *  category). Survives session deletion; only {@link clearLedger} resets it. */
export function recordLedger(
  sqlite: Database,
  provider: string,
  model: string,
  category: LedgerCategory,
  usage: TokenUsage,
  costUsd = 0
): void {
  const now = new Date();
  sqlite
    .query(
      `INSERT INTO usage_ledger
         (day, provider, model, category, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, updated_at)
       VALUES ($day, $p, $m, $cat, $in, $out, $cr, $cw, $rt, $cost, $at)
       ON CONFLICT(day, provider, model, category) DO UPDATE SET
         input_tokens       = input_tokens       + $in,
         output_tokens      = output_tokens      + $out,
         cache_read_tokens  = cache_read_tokens  + $cr,
         cache_write_tokens = cache_write_tokens + $cw,
         reasoning_tokens   = reasoning_tokens   + $rt,
         cost_usd           = cost_usd           + $cost,
         updated_at         = $at`
    )
    .run({
      $day: localDay(now),
      $p: provider,
      $m: model,
      $cat: category,
      $in: usage.inputTokens ?? 0,
      $out: usage.outputTokens ?? 0,
      $cr: usage.cacheReadTokens ?? 0,
      $cw: usage.cacheWriteTokens ?? 0,
      $rt: usage.reasoningTokens ?? 0,
      $cost: costUsd,
      $at: now.toISOString()
    });
}

/** Cumulative ledger per provider/model (summed across days + categories), most-expensive first. */
export function ledger(sqlite: Database): LedgerEntry[] {
  const rows = sqlite
    .query(
      `SELECT provider, model,
              SUM(input_tokens)       AS input_tokens,
              SUM(output_tokens)      AS output_tokens,
              SUM(cache_read_tokens)  AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(reasoning_tokens)   AS reasoning_tokens,
              SUM(cost_usd)           AS cost_usd,
              MAX(updated_at)         AS updated_at
       FROM usage_ledger
       GROUP BY provider, model
       ORDER BY cost_usd DESC`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    provider: r.provider as string,
    model: r.model as string,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    reasoningTokens: r.reasoning_tokens as number,
    costUsd: r.cost_usd as number,
    updatedAt: r.updated_at as string
  }));
}

/** Every ledger row with its full dimensions (day × provider × model × category), recent-first.
 *  Powers the global multi-dimensional usage view; callers group by whichever dims they show. */
export function ledgerBreakdown(sqlite: Database): LedgerBreakdownRow[] {
  const rows = sqlite.query('SELECT * FROM usage_ledger ORDER BY day DESC, cost_usd DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    day: r.day as string,
    provider: r.provider as string,
    model: r.model as string,
    category: r.category as LedgerCategory,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    reasoningTokens: r.reasoning_tokens as number,
    costUsd: r.cost_usd as number,
    updatedAt: r.updated_at as string
  }));
}

/** Manually wipe the global ledger — the only way to reset billing ("重新开始计费"). */
export function clearLedger(sqlite: Database): void {
  sqlite.query('DELETE FROM usage_ledger').run();
}

/** Pre-aggregated stats for the dashboard (Overview + Models tabs). */
export function computeStats(sqlite: Database, range: StatsRange = 'all'): GetStatsResponse {
  const sinceDay =
    range === '7d'
      ? localDay(new Date(Date.now() - 6 * 86400_000))
      : range === '30d'
        ? localDay(new Date(Date.now() - 29 * 86400_000))
        : null;

  // sessions.created_at and messages.created_at are UTC ISO-8601 strings.
  // sinceDay is a local YYYY-MM-DD; convert to local-midnight UTC for correct string comparison.
  const sinceUtc = sinceDay ? new Date(`${sinceDay}T00:00:00`).toISOString() : null;

  const sessionCount = (
    sinceUtc
      ? sqlite.query('SELECT COUNT(*) AS n FROM sessions WHERE created_at >= $since').get({ $since: sinceUtc })
      : sqlite.query('SELECT COUNT(*) AS n FROM sessions').get()
  ) as { n: number };

  const messageCount = (
    sinceUtc
      ? sqlite
          .query('SELECT COUNT(*) AS n FROM messages m WHERE m.created_at >= $since AND m.active = 1')
          .get({ $since: sinceUtc })
      : sqlite.query('SELECT COUNT(*) AS n FROM messages m WHERE m.active = 1').get()
  ) as { n: number };

  // Ledger day column is local YYYY-MM-DD — filter directly against sinceDay (same TZ).
  const dayRows = (
    sinceDay
      ? sqlite
          .query(
            `SELECT day, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) AS total
             FROM usage_ledger WHERE day >= $since GROUP BY day ORDER BY day ASC`
          )
          .all({ $since: sinceDay })
      : sqlite
          .query(
            `SELECT day, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) AS total
             FROM usage_ledger GROUP BY day ORDER BY day ASC`
          )
          .all()
  ) as Array<{ day: string; total: number }>;

  const heatmap: DayBucket[] = dayRows.map((r) => ({ day: r.day, totalTokens: r.total }));

  const activeDays = heatmap.length;
  const totalTokens = heatmap.reduce((s, d) => s + d.totalTokens, 0);

  const daySet = new Set(heatmap.map((d) => d.day));
  const today = localDay(new Date());
  let currentStreak = 0;
  {
    let d = today;
    while (daySet.has(d)) {
      currentStreak++;
      d = localDay(new Date(new Date(`${d}T00:00:00`).getTime() - 86400_000));
    }
  }
  let longestStreak = 0;
  {
    let run = 0;
    let prev: string | null = null;
    for (const { day } of heatmap) {
      if (prev === null) {
        run = 1;
      } else {
        const expected = localDay(new Date(new Date(`${prev}T00:00:00`).getTime() + 86400_000));
        run = day === expected ? run + 1 : 1;
      }
      if (run > longestStreak) longestStreak = run;
      prev = day;
    }
  }

  // peakHour: getHours() returns daemon-local hour — reflects server TZ until client passes its UTC offset.
  const hourRows = (
    sinceUtc
      ? sqlite
          .query('SELECT created_at FROM messages WHERE active = 1 AND created_at >= $since')
          .all({ $since: sinceUtc })
      : sqlite.query('SELECT created_at FROM messages WHERE active = 1').all()
  ) as Array<{ created_at: string }>;
  const hourBuckets = new Array<number>(24).fill(0);
  for (const { created_at } of hourRows) {
    const h = new Date(created_at).getHours();
    hourBuckets[h] = (hourBuckets[h] ?? 0) + 1;
  }
  const peakHour = hourRows.length === 0 ? null : hourBuckets.indexOf(Math.max(...hourBuckets));

  const modelRows = (
    sinceDay
      ? sqlite
          .query(
            `SELECT provider, model,
                    SUM(input_tokens)  AS input_tokens,
                    SUM(output_tokens) AS output_tokens,
                    SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) AS total_tokens
             FROM usage_ledger WHERE day >= $since GROUP BY provider, model ORDER BY total_tokens DESC`
          )
          .all({ $since: sinceDay })
      : sqlite
          .query(
            `SELECT provider, model,
                    SUM(input_tokens)  AS input_tokens,
                    SUM(output_tokens) AS output_tokens,
                    SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens) AS total_tokens
             FROM usage_ledger GROUP BY provider, model ORDER BY total_tokens DESC`
          )
          .all()
  ) as Array<{
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>;

  const grandTotal = modelRows.reduce((s, r) => s + r.total_tokens, 0);
  const models: ModelShare[] = modelRows.map((r) => ({
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    pct: grandTotal > 0 ? Math.round((r.total_tokens / grandTotal) * 1000) / 10 : 0
  }));

  const favoriteModel = models.length > 0 ? (models[0]?.model ?? null) : null;

  return {
    range,
    sessions: sessionCount.n,
    messages: messageCount.n,
    totalTokens,
    activeDays,
    currentStreak,
    longestStreak,
    peakHour,
    favoriteModel,
    heatmap,
    models
  };
}
