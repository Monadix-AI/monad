// Native CLI inbox: the queued/delivered/visible/consumed lifecycle of messages routed to a native
// CLI session, plus the delivery-record projection. Split out of index.ts — every function takes the
// raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type {
  MessageId,
  NativeAgentDelivery,
  NativeAgentDeliveryId,
  NativeCliInboxDeliveryState,
  NativeCliInboxItem,
  ProjectId
} from '@monad/protocol';

import { nativeAgentDeliverySchema, newId } from '@monad/protocol';

import { getNativeCliSession, setNativeCliDeliveredCursor, setNativeCliVisibleCursor } from './native-cli-sessions.ts';
import { type MessageRow, rowToMessage } from './row-mappers.ts';

export interface EnqueueNativeCliInboxOptions {
  deliveryId?: NativeAgentDeliveryId;
  projectId?: ProjectId;
  memberInstanceId?: string;
  triggerMessageId?: MessageId;
  providerSessionRef?: string | null;
  providerTurnId?: string | null;
  errorSummary?: string | null;
  createdAt?: string;
}

export function enqueueNativeCliInboxItem(
  sqlite: Database,
  nativeCliSessionId: string,
  messageSeq: number,
  createdAtOrOptions: string | EnqueueNativeCliInboxOptions = new Date().toISOString()
): boolean {
  const options = typeof createdAtOrOptions === 'string' ? { createdAt: createdAtOrOptions } : createdAtOrOptions;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const result = sqlite
    .query(
      `INSERT OR IGNORE INTO native_cli_inbox_items
         (native_cli_session_id, message_seq, delivery_id, project_id, member_instance_id, trigger_message_id,
          provider_session_ref, provider_turn_id, error_summary, state, created_at, updated_at)
       VALUES ($nativeCliSessionId, $messageSeq, $deliveryId, $projectId, $memberInstanceId, $triggerMessageId,
          $providerSessionRef, $providerTurnId, $errorSummary, 'queued', $createdAt, $createdAt)`
    )
    .run({
      $nativeCliSessionId: nativeCliSessionId,
      $messageSeq: messageSeq,
      $deliveryId: options.deliveryId ?? newId('deliv'),
      $projectId: options.projectId ?? null,
      $memberInstanceId: options.memberInstanceId ?? null,
      $triggerMessageId: options.triggerMessageId ?? null,
      $providerSessionRef: options.providerSessionRef ?? null,
      $providerTurnId: options.providerTurnId ?? null,
      $errorSummary: options.errorSummary ?? null,
      $createdAt: createdAt
    });
  return result.changes > 0;
}

export function markNativeCliInboxDelivered(
  sqlite: Database,
  nativeCliSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  const update = sqlite
    .query(
      `UPDATE native_cli_inbox_items
       SET state = CASE WHEN state = 'queued' THEN 'delivered' ELSE state END,
           delivered_at = COALESCE(delivered_at, ?),
           updated_at = ?
       WHERE native_cli_session_id = ?
         AND message_seq <= ?
         AND state IN ('queued', 'delivered', 'visible')`
    )
    .run(at, at, nativeCliSessionId, cursor);
  const cursorUpdated = setNativeCliDeliveredCursor(sqlite, nativeCliSessionId, cursor);
  return update.changes > 0 || cursorUpdated;
}

export function markNativeCliInboxVisible(
  sqlite: Database,
  nativeCliSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  const update = sqlite
    .query(
      `UPDATE native_cli_inbox_items
       SET state = CASE WHEN state IN ('queued', 'delivered') THEN 'visible' ELSE state END,
           visible_at = COALESCE(visible_at, ?),
           updated_at = ?
       WHERE native_cli_session_id = ?
         AND message_seq <= ?
         AND state IN ('queued', 'delivered', 'visible')`
    )
    .run(at, at, nativeCliSessionId, cursor);
  const cursorUpdated = setNativeCliVisibleCursor(sqlite, nativeCliSessionId, cursor);
  return update.changes > 0 || cursorUpdated;
}

export function markNativeCliInboxConsumed(
  sqlite: Database,
  nativeCliSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  const update = sqlite
    .query(
      `UPDATE native_cli_inbox_items
       SET state = 'consumed',
           consumed_at = COALESCE(consumed_at, ?),
           updated_at = ?
       WHERE native_cli_session_id = ?
         AND message_seq <= ?
         AND state IN ('queued', 'delivered', 'visible')`
    )
    .run(at, at, nativeCliSessionId, cursor);
  const visibleUpdated = setNativeCliVisibleCursor(sqlite, nativeCliSessionId, cursor);
  return update.changes > 0 || visibleUpdated;
}

export function hasUnconsumedNativeCliInbox(sqlite: Database, nativeCliSessionId: string, cursor?: number): boolean {
  const session = getNativeCliSession(sqlite, nativeCliSessionId);
  if (!session) return false;
  const maxSeq = cursor ?? session.lastDeliveredSeq;
  if (maxSeq <= 0) return false;
  const row = sqlite
    .query(
      `SELECT 1 AS found
       FROM native_cli_inbox_items
       WHERE native_cli_session_id = ?
         AND message_seq <= ?
         AND state != 'consumed'
       LIMIT 1`
    )
    .get(nativeCliSessionId, maxSeq) as { found: number } | null;
  return !!row;
}

export function listNativeCliInbox(sqlite: Database, nativeCliSessionId: string, limit = 50): NativeCliInboxItem[] {
  const session = getNativeCliSession(sqlite, nativeCliSessionId);
  if (!session) return [];
  const rows = sqlite
    .query(
      `SELECT m.*, i.message_seq AS _native_cli_seq, i.delivery_id AS _native_cli_delivery_id,
              i.state AS _native_cli_state
       FROM native_cli_inbox_items i
       JOIN messages m ON m.rowid = i.message_seq
       WHERE i.native_cli_session_id = ?
         AND i.message_seq > ?
         AND i.state != 'consumed'
         AND m.active = 1
       ORDER BY i.message_seq ASC
       LIMIT ?`
    )
    .all(nativeCliSessionId, session.lastVisibleSeq, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    seq: row._native_cli_seq as number,
    deliveryId: (row._native_cli_delivery_id ?? undefined) as NativeAgentDeliveryId | undefined,
    deliveryState: row._native_cli_state as NativeCliInboxDeliveryState,
    message: rowToMessage({
      id: row.id as string,
      transcriptTargetId: row.transcript_target_id as string,
      role: row.role as string,
      text: row.text as string,
      type: row.type as string,
      data: (row.data ?? null) as string | null,
      streamStatus: row.stream_status as string,
      active: row.active as number,
      includeInContext: (row.include_in_context ?? null) as number | null,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at ?? null) as string | null
    } as MessageRow)
  }));
}

export function countNativeCliInbox(sqlite: Database, nativeCliSessionId: string): number {
  const session = getNativeCliSession(sqlite, nativeCliSessionId);
  if (!session) return 0;
  const row = sqlite
    .query(
      `SELECT COUNT(*) AS count
       FROM native_cli_inbox_items i
       JOIN messages m ON m.rowid = i.message_seq
       WHERE i.native_cli_session_id = ?
         AND i.message_seq > ?
         AND i.state != 'consumed'
         AND m.active = 1`
    )
    .get(nativeCliSessionId, session.lastVisibleSeq) as { count: number } | null;
  return row?.count ?? 0;
}

export function getNativeAgentDelivery(
  sqlite: Database,
  deliveryId: NativeAgentDeliveryId
): NativeAgentDelivery | null {
  const row = sqlite
    .query(
      `SELECT i.*, s.transcript_target_id, s.agent_name, s.provider_session_ref AS session_provider_session_ref
       FROM native_cli_inbox_items i
       JOIN native_cli_sessions s ON s.id = i.native_cli_session_id
       WHERE i.delivery_id = ?`
    )
    .get(deliveryId) as Record<string, unknown> | null;
  if (!row) return null;
  const projectId = (row.project_id ?? row.transcript_target_id) as string;
  if (!projectId.startsWith('prj_')) return null;
  return nativeAgentDeliverySchema.parse({
    id: row.delivery_id,
    projectId,
    memberInstanceId: row.member_instance_id ?? row.agent_name,
    nativeCliSessionId: row.native_cli_session_id,
    triggerMessageId: row.trigger_message_id ?? undefined,
    triggerMessageSeq: row.message_seq,
    state: row.error_summary ? 'failed' : row.state,
    turn: {
      providerSessionRef: row.provider_session_ref ?? row.session_provider_session_ref ?? null,
      providerTurnId: row.provider_turn_id ?? null
    },
    errorSummary: row.error_summary ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.consumed_at ?? row.visible_at ?? row.delivered_at ?? row.created_at
  });
}
