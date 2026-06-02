// Durable event log: append + resume-cursor reads + dangling-interrupt reconciliation. Split out of
// index.ts — every function takes the raw bun:sqlite handle. Events are idempotent by id.

import type { Database } from 'bun:sqlite';
import type { ClarifyRespondResponse, Event, EventType } from '@monad/protocol';

import { parseEvent, parsePersistedEvent } from '@monad/protocol';

/** Idempotent on id (INSERT OR IGNORE). */
export function appendEvents(sqlite: Database, batch: Event[]): void {
  if (batch.length === 0) return;
  const events = batch.map(parseEvent);
  const insert = sqlite.query(
    'INSERT OR IGNORE INTO events (id, transcript_target_id, type, actor_agent_id, task_id, payload, at) VALUES ($id, $transcriptTargetId, $type, $actorAgentId, $taskId, $payload, $at)'
  );
  const tx = sqlite.transaction((rows: Event[]) => {
    for (const e of rows) {
      insert.run({
        $id: e.id,
        $transcriptTargetId: e.sessionId,
        $type: e.type,
        $actorAgentId: e.actorAgentId,
        $taskId: e.taskId ?? null,
        $payload: JSON.stringify(e.payload),
        $at: e.at
      });
    }
  });
  tx(events);
}

export interface DanglingInterrupt {
  type: 'approval' | 'clarify';
  requestId: string;
  sessionId: string;
  tool?: string;
}

/** Mark pre-canonical clarification requests that cannot be restored after restart. */
export function reconcileLegacyClarificationEvents(sqlite: Database): number {
  const result = sqlite
    .query(
      `UPDATE events
       SET payload = json_set(payload, '$.legacyResolution', 'cancelled')
       WHERE type = 'clarify.requested'
         AND json_type(payload, '$.questionMessageId') IS NULL
         AND json_type(payload, '$.legacyResolution') IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM events r
           WHERE r.type = 'clarify.resolved'
             AND r.transcript_target_id = events.transcript_target_id
             AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
         )`
    )
    .run();
  return result.changes;
}

/** Find approval/clarify requests that have no matching resolved event (left dangling by a restart). */
export function findDanglingInterrupts(sqlite: Database): DanglingInterrupt[] {
  const approvals = sqlite
    .query(
      `SELECT transcript_target_id,
              json_extract(payload, '$.requestId') AS request_id,
              json_extract(payload, '$.tool')      AS tool
       FROM events
       WHERE type = 'tool.approval_requested'
         AND NOT EXISTS (
           SELECT 1 FROM events r
           WHERE r.type = 'tool.approval_resolved'
             AND r.transcript_target_id = events.transcript_target_id
             AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
         )`
    )
    .all() as Array<{ transcript_target_id: string; request_id: string | null; tool: string | null }>;
  const clarifies = sqlite
    .query(
      `SELECT transcript_target_id,
              json_extract(payload, '$.requestId') AS request_id
       FROM events
       WHERE type = 'clarify.requested'
         AND json_type(payload, '$.questionMessageId') = 'text'
         AND NOT EXISTS (
           SELECT 1 FROM events r
           WHERE r.type = 'clarify.resolved'
             AND r.transcript_target_id = events.transcript_target_id
             AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
         )`
    )
    .all() as Array<{ transcript_target_id: string; request_id: string | null }>;
  return [
    ...approvals
      .filter((r): r is typeof r & { request_id: string } => r.request_id !== null)
      .map((r) => ({
        type: 'approval' as const,
        requestId: r.request_id,
        sessionId: r.transcript_target_id,
        tool: r.tool ?? undefined
      })),
    ...clarifies
      .filter((r): r is typeof r & { request_id: string } => r.request_id !== null)
      .map((r) => ({ type: 'clarify' as const, requestId: r.request_id, sessionId: r.transcript_target_id }))
  ];
}

export function getClarificationResolution(sqlite: Database, requestId: string): ClarifyRespondResponse | null {
  const row = sqlite
    .query(
      `SELECT payload, at FROM events
       WHERE type = 'clarify.resolved'
         AND json_extract(payload, '$.requestId') = ?
       ORDER BY rowid DESC LIMIT 1`
    )
    .get(requestId) as { payload: string; at: string } | null;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as { answer?: unknown; reason?: unknown };
  if (payload.reason === 'timeout') return { status: 'timed-out', resolvedAt: row.at };
  if (payload.reason === 'cancelled' || payload.reason === 'aborted' || payload.reason === 'settlement_failed')
    return { status: 'cancelled', resolvedAt: row.at };
  return { status: 'answered', answer: typeof payload.answer === 'string' ? payload.answer : '', resolvedAt: row.at };
}

/** True when `eventId` is present in the durable event log. Lets callers distinguish a persisted
 *  cursor from an un-persisted live message delta before calling {@link listEvents},
 *  whose missing-cursor fallback would otherwise replay the whole session. */
export function hasEvent(sqlite: Database, transcriptTargetId: string, eventId: string): boolean {
  return (
    sqlite
      .query('SELECT 1 FROM events WHERE transcript_target_id = ?1 AND id = ?2 LIMIT 1')
      .get(transcriptTargetId, eventId) !== null
  );
}

/** Three-way durable-anchor check for scope-bound replay cursors: `durable` when the event exists
 *  in this transcript's log, `other_scope` when it exists under a different transcript (a cross-scope
 *  cursor that must be rejected), `missing` when unknown. Event ids are globally unique, so a single
 *  lookup distinguishes all three. */
export function eventAnchorStatus(
  sqlite: Database,
  transcriptTargetId: string,
  eventId: string
): 'durable' | 'other_scope' | 'missing' {
  const row = sqlite.query('SELECT transcript_target_id FROM events WHERE id = ?1 LIMIT 1').get(eventId) as {
    transcript_target_id: string;
  } | null;
  if (!row) return 'missing';
  return row.transcript_target_id === transcriptTargetId ? 'durable' : 'other_scope';
}

/** Newest durably-appended event id for a transcript, or undefined when the log is empty. Used as the
 *  baseline snapshot cursor when no live round is buffered. */
export function latestEventId(sqlite: Database, transcriptTargetId: string): string | undefined {
  const row = sqlite
    .query('SELECT id FROM events WHERE transcript_target_id = ?1 ORDER BY rowid DESC LIMIT 1')
    .get(transcriptTargetId) as { id: string } | null;
  return row?.id;
}

/** Exclusive cursor; falls back to the whole session if `afterEventId` is not in the log. Pass `limit`
 *  to read one bounded page (ascending) so a large tail can be replayed page-by-page without
 *  materialising the whole log into memory. */
export function listEvents(sqlite: Database, sessionId: string, afterEventId?: string, limit?: number): Event[] {
  const rows = sqlite
    .query(
      `SELECT id, transcript_target_id, type, actor_agent_id, task_id, payload, at
       FROM events
       WHERE transcript_target_id = $transcriptTargetId
         AND rowid > COALESCE(
           (SELECT rowid FROM events WHERE transcript_target_id = $transcriptTargetId AND id = $after),
           -1
         )
       ORDER BY rowid ASC${limit === undefined ? '' : ' LIMIT $limit'}`
    )
    .all(
      limit === undefined
        ? { $transcriptTargetId: sessionId, $after: afterEventId ?? null }
        : { $transcriptTargetId: sessionId, $after: afterEventId ?? null, $limit: limit }
    ) as Array<{
    id: string;
    transcript_target_id: string;
    type: string;
    actor_agent_id: string | null;
    task_id: string | null;
    payload: string;
    at: string;
  }>;
  return rows.flatMap((r) => {
    const event = parsePersistedEvent({
      id: r.id,
      sessionId: r.transcript_target_id,
      type: r.type,
      actorAgentId: r.actor_agent_id,
      ...(r.task_id ? { taskId: r.task_id } : {}),
      payload: JSON.parse(r.payload),
      at: r.at
    });
    return event ? [event] : [];
  });
}

export function listRecentEventsOfTypes(
  sqlite: Database,
  sessionId: string,
  types: EventType[],
  limit: number
): Event[] {
  if (types.length === 0 || limit <= 0) return [];
  const typePlaceholders = types.map((_, index) => `$type${index}`).join(', ');
  const params: Record<string, string | number> = {
    $transcriptTargetId: sessionId,
    $limit: limit
  };
  types.forEach((type, index) => {
    params[`$type${index}`] = type;
  });
  const rows = sqlite
    .query(
      `SELECT id, transcript_target_id, type, actor_agent_id, task_id, payload, at
       FROM (
         SELECT rowid, id, transcript_target_id, type, actor_agent_id, task_id, payload, at
         FROM events
         WHERE transcript_target_id = $transcriptTargetId
           AND type IN (${typePlaceholders})
         ORDER BY rowid DESC
         LIMIT $limit
       )
       ORDER BY rowid ASC`
    )
    .all(params) as Array<{
    id: string;
    transcript_target_id: string;
    type: string;
    actor_agent_id: string | null;
    task_id: string | null;
    payload: string;
    at: string;
  }>;
  return rows.flatMap((row) => {
    const event = parsePersistedEvent({
      id: row.id,
      sessionId: row.transcript_target_id,
      type: row.type,
      actorAgentId: row.actor_agent_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      payload: JSON.parse(row.payload),
      at: row.at
    });
    return event ? [event] : [];
  });
}

export function listPendingInteractionEvents(sqlite: Database, sessionId: string): Event[] {
  const rows = sqlite
    .query(
      `SELECT request.id, request.transcript_target_id, request.type, request.actor_agent_id,
              request.task_id, request.payload, request.at
       FROM events request
       WHERE request.transcript_target_id = $transcriptTargetId
         AND (
           request.type = 'tool.approval_requested'
           OR request.type = 'mesh.approval_requested'
           OR (
             request.type = 'clarify.requested'
             AND json_type(request.payload, '$.questionMessageId') = 'text'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM events resolved
           WHERE resolved.transcript_target_id = request.transcript_target_id
             AND json_extract(resolved.payload, '$.requestId') = json_extract(request.payload, '$.requestId')
             AND resolved.type = CASE request.type
               WHEN 'tool.approval_requested' THEN 'tool.approval_resolved'
               WHEN 'mesh.approval_requested' THEN 'mesh.approval_resolved'
               ELSE 'clarify.resolved'
             END
         )
       ORDER BY request.rowid ASC`
    )
    .all({ $transcriptTargetId: sessionId }) as Array<{
    id: string;
    transcript_target_id: string;
    type: string;
    actor_agent_id: string | null;
    task_id: string | null;
    payload: string;
    at: string;
  }>;
  return rows.flatMap((row) => {
    const event = parsePersistedEvent({
      id: row.id,
      sessionId: row.transcript_target_id,
      type: row.type,
      actorAgentId: row.actor_agent_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      payload: JSON.parse(row.payload),
      at: row.at
    });
    return event ? [event] : [];
  });
}
