import type { ExternalAgentObservationEvent } from '@monad/protocol';

import { Database } from 'bun:sqlite';
import { externalAgentObservationEventSchema } from '@monad/protocol';

export function recordExternalAgentObservationEvents(
  sqlite: Database,
  externalAgentSessionId: string,
  events: ExternalAgentObservationEvent[],
  observedAt: string
): void {
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO external_agent_observation_events
      (external_agent_session_id, dedupe_key, event_json, observed_at)
     VALUES (?, ?, ?, ?)`
  );
  const transaction = sqlite.transaction((batch: ExternalAgentObservationEvent[]) => {
    for (const event of batch) {
      if (!event.dedupeKey) continue;
      insert.run(externalAgentSessionId, event.dedupeKey, JSON.stringify(event), observedAt);
    }
  });
  transaction(events);
}

export function listExternalAgentObservationEvents(
  sqlite: Database,
  externalAgentSessionId: string,
  request: { before?: string; limit: number; sortDirection: 'asc' | 'desc' }
): { events: ExternalAgentObservationEvent[]; nextCursor?: string } {
  const before = request.before ? Number.parseInt(request.before, 10) : undefined;
  const hasBefore = before !== undefined && Number.isFinite(before) && before > 0;
  const direction = request.sortDirection === 'asc' ? 'ASC' : 'DESC';
  const rows = sqlite
    .query(
      `SELECT seq, event_json
       FROM external_agent_observation_events
       WHERE external_agent_session_id = ?${hasBefore ? ' AND seq < ?' : ''}
       ORDER BY seq ${direction}
       LIMIT ?`
    )
    .all(
      ...(hasBefore ? [externalAgentSessionId, before, request.limit + 1] : [externalAgentSessionId, request.limit + 1])
    ) as Array<{
    seq: number;
    event_json: string;
  }>;
  const hasMore = rows.length > request.limit;
  const pageRows = hasMore ? rows.slice(0, request.limit) : rows;
  const events = pageRows.flatMap((row) => {
    try {
      const parsed = externalAgentObservationEventSchema.safeParse(JSON.parse(row.event_json));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
  const last = pageRows.at(-1);
  return { events, ...(hasMore && last ? { nextCursor: String(last.seq) } : {}) };
}
