// Durable event log: append + resume-cursor reads + dangling-interrupt reconciliation. Split out of
// index.ts — every function takes the raw bun:sqlite handle. Events are idempotent by id.

import type { Database } from 'bun:sqlite';
import type { ClarifyRespondResponse, Event } from '@monad/protocol';

import { parseEvent } from '@monad/protocol';

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
  if (payload.reason === 'cancelled' || payload.reason === 'aborted')
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

/** Exclusive cursor; falls back to the whole session if `afterEventId` is not in the log. */
export function listEvents(sqlite: Database, sessionId: string, afterEventId?: string): Event[] {
  const rows = sqlite
    .query(
      `SELECT id, transcript_target_id, type, actor_agent_id, task_id, payload, at
       FROM events
       WHERE transcript_target_id = $transcriptTargetId
         AND rowid > COALESCE(
           (SELECT rowid FROM events WHERE transcript_target_id = $transcriptTargetId AND id = $after),
           -1
         )
       ORDER BY rowid ASC`
    )
    .all({ $transcriptTargetId: sessionId, $after: afterEventId ?? null }) as Array<{
    id: string;
    transcript_target_id: string;
    type: string;
    actor_agent_id: string | null;
    task_id: string | null;
    payload: string;
    at: string;
  }>;
  return rows.map((r) =>
    parseEvent({
      id: r.id,
      sessionId: r.transcript_target_id,
      type: r.type,
      actorAgentId: r.actor_agent_id,
      ...(r.task_id ? { taskId: r.task_id } : {}),
      payload: JSON.parse(r.payload),
      at: r.at
    })
  );
}
