// Scope-local monotonic event sequences. Each scope (a session/project transcript target id, or the
// stable daemon scope) has its own strictly increasing counter, persisted as a high-watermark so a
// crash or restart never re-issues or regresses a number. The allocator is the single source of
// sequence numbers; producers never compute their own.

import type { Database } from 'bun:sqlite';

export interface EventSequenceRange {
  /** First sequence in the reserved range (1-based, strictly increasing per scope). */
  start: number;
  /** Last sequence in the reserved range: `start + count - 1`. */
  end: number;
}

/**
 * Atomically reserve `count` consecutive sequence numbers for `scope`. The read-and-bump is a single
 * UPSERT so two allocations for the same scope can never hand out overlapping ranges, and the
 * persisted watermark means a reopened database continues from the last issued number. Reserve the
 * range inside the same transaction that writes the events it numbers, so a rolled-back batch does
 * not burn sequence numbers.
 */
export function allocateEventSequence(sqlite: Database, scope: string, count = 1): EventSequenceRange {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`event sequence count must be a positive integer, got ${count}`);
  }
  const row = sqlite
    .query(
      `INSERT INTO event_scope_sequence (scope, high_watermark) VALUES ($scope, $count)
       ON CONFLICT(scope) DO UPDATE SET high_watermark = high_watermark + $count
       RETURNING high_watermark AS "end"`
    )
    .get({ $scope: scope, $count: count }) as { end: number };
  return { start: row.end - count + 1, end: row.end };
}

/** Current high-watermark for a scope — the last issued sequence, or 0 if none has been allocated. */
export function eventSequenceWatermark(sqlite: Database, scope: string): number {
  const row = sqlite.query('SELECT high_watermark AS hw FROM event_scope_sequence WHERE scope = ?').get(scope) as {
    hw: number;
  } | null;
  return row?.hw ?? 0;
}
