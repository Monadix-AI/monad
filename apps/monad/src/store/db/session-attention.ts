import type { Database } from 'bun:sqlite';
import type {
  ConsumeSessionAttentionRequest,
  ConsumeSessionAttentionResponse,
  SessionAttentionState,
  SessionAttentionSummary,
  SessionGenerationState,
  SessionId
} from '@monad/protocol';

import { newId, sessionAttentionSummarySchema } from '@monad/protocol';

export interface SessionAttentionSourceInput {
  sessionId: SessionId;
  itemKey: string;
  kind: SessionAttentionState;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
}

interface SessionActivityRow {
  id: string;
  activity_at: string;
}

interface AttentionRow {
  session_id: string;
  item_key: string;
  kind: SessionAttentionState;
  occurred_at: string;
}

interface GenerationStateRow {
  session_id: string;
  generation_state: SessionGenerationState | null;
}

const priority: Record<SessionAttentionState, number> = {
  unread: 1,
  'need-response': 2,
  'need-approval': 3
};

export function applySessionAttentionSource(sqlite: Database, input: SessionAttentionSourceInput): void {
  const apply = sqlite.transaction((value: SessionAttentionSourceInput) => {
    advanceSessionActivity(sqlite, value.sessionId, value.occurredAt);
    sqlite
      .query(
        `INSERT OR IGNORE INTO session_attention_items
           (item_key, session_id, kind, source_type, source_id, occurred_at, created_at)
         VALUES ($itemKey, $sessionId, $kind, $sourceType, $sourceId, $occurredAt, $createdAt)`
      )
      .run({
        $itemKey: value.itemKey,
        $sessionId: value.sessionId,
        $kind: value.kind,
        $sourceType: value.sourceType,
        $sourceId: value.sourceId,
        $occurredAt: value.occurredAt,
        $createdAt: new Date().toISOString()
      });
  });
  apply(input);
}

export function advanceSessionActivity(sqlite: Database, sessionId: SessionId, occurredAt: string): void {
  const updated = sqlite
    .query('UPDATE sessions SET activity_at = MAX(activity_at, $occurredAt) WHERE id = $sessionId')
    .run({ $occurredAt: occurredAt, $sessionId: sessionId });
  if (updated.changes === 0) throw new Error(`Session not found: ${sessionId}`);
}

export function reconcileSessionActionAttention(sqlite: Database, reconciledAt: string): void {
  sqlite.transaction(() => {
    sqlite.query("DELETE FROM session_attention_items WHERE kind IN ('need-approval', 'need-response')").run();
    sqlite
      .query(
        `INSERT OR IGNORE INTO session_attention_items
           (item_key, session_id, kind, source_type, source_id, occurred_at, created_at)
         SELECT
           CASE request.type
             WHEN 'clarify.requested' THEN 'response:' || json_extract(request.payload, '$.requestId')
             ELSE 'approval:' || json_extract(request.payload, '$.requestId')
           END,
           request.transcript_target_id,
           CASE request.type WHEN 'clarify.requested' THEN 'need-response' ELSE 'need-approval' END,
           CASE request.type WHEN 'clarify.requested' THEN 'response' ELSE 'approval' END,
           json_extract(request.payload, '$.requestId'),
           request.at,
           $reconciledAt
         FROM events request
         JOIN sessions session ON session.id = request.transcript_target_id
         WHERE request.type IN ('tool.approval_requested', 'mesh.approval_requested', 'clarify.requested')
           AND session.archived = 0
           AND json_type(request.payload, '$.requestId') = 'text'
           AND NOT EXISTS (
             SELECT 1
             FROM events resolved
             WHERE resolved.transcript_target_id = request.transcript_target_id
               AND json_extract(resolved.payload, '$.requestId') = json_extract(request.payload, '$.requestId')
               AND resolved.type = CASE request.type
                 WHEN 'tool.approval_requested' THEN 'tool.approval_resolved'
                 WHEN 'mesh.approval_requested' THEN 'mesh.approval_resolved'
                 ELSE 'clarify.resolved'
               END
           )`
      )
      .run({ $reconciledAt: reconciledAt });
  })();
}

export function listSessionAttention(sqlite: Database, sessionIds: readonly SessionId[]): SessionAttentionSummary[] {
  if (sessionIds.length === 0) return [];
  const placeholders = sessionIds.map(() => '?').join(', ');
  const sessions = sqlite
    .query(`SELECT id, activity_at FROM sessions WHERE id IN (${placeholders})`)
    .all(...sessionIds) as SessionActivityRow[];
  const items = sqlite
    .query(
      `SELECT session_id, item_key, kind, occurred_at
       FROM session_attention_items
       WHERE session_id IN (${placeholders})
       ORDER BY occurred_at ASC, item_key ASC`
    )
    .all(...sessionIds) as AttentionRow[];
  const generationStates = sqlite
    .query(
      `WITH relevant AS (
         SELECT rowid, transcript_target_id, stream_status
         FROM messages
         WHERE transcript_target_id IN (${placeholders})
           AND active = 1
           AND role = 'assistant'
           AND stream_status != 'settled'
       ), latest AS (
         SELECT transcript_target_id, MAX(rowid) AS rowid
         FROM relevant
         GROUP BY transcript_target_id
       )
       SELECT latest.transcript_target_id AS session_id,
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM relevant live
                  WHERE live.transcript_target_id = latest.transcript_target_id
                    AND live.stream_status IN ('pending', 'streaming')
                ) THEN 'running'
                WHEN message.stream_status = 'error' THEN 'error'
                ELSE NULL
              END AS generation_state
       FROM latest
       JOIN messages message ON message.rowid = latest.rowid`
    )
    .all(...sessionIds) as GenerationStateRow[];
  const itemsBySession = new Map<string, AttentionRow[]>();
  for (const item of items) {
    const group = itemsBySession.get(item.session_id) ?? [];
    group.push(item);
    itemsBySession.set(item.session_id, group);
  }
  const sessionsById = new Map(sessions.map((row) => [row.id, row]));
  const generationStateBySessionId = new Map(
    generationStates.map((row) => [row.session_id, row.generation_state] as const)
  );
  return sessionIds.flatMap((sessionId) => {
    const session = sessionsById.get(sessionId);
    if (!session) return [];
    const sessionItems = itemsBySession.get(sessionId) ?? [];
    const state = sessionItems.reduce<SessionAttentionState | null>(
      (current, item) => (current === null || priority[item.kind] > priority[current] ? item.kind : current),
      null
    );
    return [
      sessionAttentionSummarySchema.parse({
        sessionId,
        state,
        generationState: generationStateBySessionId.get(sessionId) ?? null,
        activityAt: session.activity_at,
        unreadItemKeys: sessionItems.filter((item) => item.kind === 'unread').map((item) => item.item_key)
      })
    ];
  });
}

export function consumeSessionAttention(
  sqlite: Database,
  sessionId: SessionId,
  itemKeys: readonly string[],
  cause: ConsumeSessionAttentionRequest['cause'],
  at: string
): ConsumeSessionAttentionResponse {
  if (itemKeys.length === 0) return { consumedItemKeys: [] };
  const placeholders = itemKeys.map(() => '?').join(', ');
  const consume = sqlite.transaction(() => {
    const rows = sqlite
      .query(
        `SELECT item_key FROM session_attention_items
         WHERE session_id = ? AND kind = 'unread' AND item_key IN (${placeholders})
         ORDER BY occurred_at ASC, item_key ASC`
      )
      .all(sessionId, ...itemKeys) as Array<{ item_key: string }>;
    const consumedItemKeys = rows.map((row) => row.item_key);
    if (consumedItemKeys.length === 0) return { consumedItemKeys };
    const consumedPlaceholders = consumedItemKeys.map(() => '?').join(', ');
    sqlite
      .query(
        `DELETE FROM session_attention_items
         WHERE session_id = ? AND kind = 'unread' AND item_key IN (${consumedPlaceholders})`
      )
      .run(sessionId, ...consumedItemKeys);
    sqlite
      .query(
        `INSERT INTO events (id, transcript_target_id, type, actor_agent_id, task_id, payload, at)
         VALUES (?, ?, 'session.attention.consumed', NULL, NULL, ?, ?)`
      )
      .run(
        newId('evt'),
        sessionId,
        JSON.stringify({ transcriptTargetId: sessionId, itemKeys: consumedItemKeys, cause }),
        at
      );
    return { consumedItemKeys };
  });
  return consume();
}

export function resolveSessionAttentionSource(
  sqlite: Database,
  sessionId: SessionId,
  sourceType: string,
  sourceId: string
): number {
  return sqlite
    .query(
      `DELETE FROM session_attention_items
       WHERE session_id = $sessionId AND source_type = $sourceType AND source_id = $sourceId AND kind != 'unread'`
    )
    .run({ $sessionId: sessionId, $sourceType: sourceType, $sourceId: sourceId }).changes;
}
