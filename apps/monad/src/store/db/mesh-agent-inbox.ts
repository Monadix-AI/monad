// External agent inbox: the queued/delivered/visible/consumed lifecycle of messages routed to a native
// CLI session, plus the delivery-record projection. Split out of index.ts — every function takes the
// raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type {
  InboxItem,
  MeshAgentInboxDeliveryState,
  MeshAgentInboxItem,
  MessageId,
  NativeAgentDelivery,
  NativeAgentDeliveryId,
  ProjectId
} from '@monad/protocol';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { nativeAgentDeliverySchema, newId } from '@monad/protocol';

import { getMeshSession, setMeshAgentDeliveredCursor, setMeshAgentVisibleCursor } from './mesh-sessions.ts';
import { enqueueNativeAgentIngressItem } from './native-agent-ingress.ts';
import { listLegacyMentionInbox } from './operator-inbox.ts';
import { type MessageRow, rowToMessage } from './row-mappers.ts';
import {
  advanceSessionBindingDeliveredCursor,
  advanceSessionBindingVisibleCursor,
  getSessionBinding
} from './session-bindings.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;

// A managed-project-agent runtime that reaches the delivery cursor path (write OR read) without a
// resolvable owning ProjectMember + SessionBinding is an invariant failure — S2-a establishes ownership at
// runtime start, so an unowned/unbound managed runtime here means the spawn→replaceSessionBindingRuntime
// linkage was skipped. It is surfaced, never papered over with a name fallback or the frozen legacy cursor.
export class MeshAgentDeliveryOwnershipError extends Error {
  constructor(readonly meshSessionId: string) {
    super(`Managed runtime ${meshSessionId} has no owning project member binding`);
    this.name = 'MeshAgentDeliveryOwnershipError';
  }
}

type DeliveryFence = { kind: 'managed'; sessionId: string; owner: string } | { kind: 'unmanaged' } | { kind: 'fenced' };

// Resolves who a delivery cursor write belongs to, strictly from the runtime's durable ownership — never
// from its agentName. A non-managed runtime keeps the legacy item+cursor-only path. A managed runtime
// must be owned (else an observable invariant error) and must still be the binding's current, ACTIVE
// attachment; a superseded, suspended, or left runtime writing late is fenced off so it can neither
// rewind nor resurrect a cursor — even if a bad state left a stale current pointer on a non-active binding.
function fenceManagedDelivery(sqlite: Database, db: Db, meshSessionId: string): DeliveryFence {
  const runtime = getMeshSession(sqlite, meshSessionId);
  if (runtime?.runtimeRole !== 'managed-project-agent') return { kind: 'unmanaged' };
  const owner = runtime.projectMemberId;
  if (!owner) throw new MeshAgentDeliveryOwnershipError(meshSessionId);
  const binding = getSessionBinding(db, runtime.transcriptTargetId, owner);
  if (binding?.lifecycle !== 'active' || binding.currentNativeRuntimeSessionId !== meshSessionId) {
    return { kind: 'fenced' };
  }
  return { kind: 'managed', sessionId: runtime.transcriptTargetId, owner };
}

// For READS, a managed runtime's effective inbox cursor is its owning SessionBinding's watermark — the
// authoritative source now that managed mesh cursors are frozen. Resolved by owner, NOT gated on the
// runtime still being the binding's current, so a superseded runtime still reads the true watermark. A
// managed runtime with no resolvable owner/binding is a fail-CLOSED invariant failure (same as the write
// path) — never the frozen legacy cursor, which would read every message as unconsumed and re-deliver it.
// A non-managed runtime uses the legacy mesh cursor. Returns null only when the runtime row itself is gone.
function resolveInboxCursor(
  sqlite: Database,
  db: Db,
  meshSessionId: string
): { deliveredSeq: number; visibleSeq: number } | null {
  const runtime = getMeshSession(sqlite, meshSessionId);
  if (!runtime) return null;
  if (runtime.runtimeRole === 'managed-project-agent') {
    if (!runtime.projectMemberId) throw new MeshAgentDeliveryOwnershipError(meshSessionId);
    const binding = getSessionBinding(db, runtime.transcriptTargetId, runtime.projectMemberId);
    if (!binding) throw new MeshAgentDeliveryOwnershipError(meshSessionId);
    return { deliveredSeq: binding.lastDeliveredSeq, visibleSeq: binding.lastVisibleSeq };
  }
  return { deliveredSeq: runtime.lastDeliveredSeq, visibleSeq: runtime.lastVisibleSeq };
}

// The effective delivered/visible watermark for a managed runtime — read from the SessionBinding (legacy
// mesh cursor when non-managed), the authoritative source now that managed mesh cursors are frozen. Used
// by the output pipeline's consume step and by the runtime-info diagnostics. Defaults to 0/0 when the
// runtime row is gone.
export function meshAgentInboxCursor(
  sqlite: Database,
  db: Db,
  meshSessionId: string
): { deliveredSeq: number; visibleSeq: number } {
  return resolveInboxCursor(sqlite, db, meshSessionId) ?? { deliveredSeq: 0, visibleSeq: 0 };
}

export interface EnqueueMeshAgentInboxOptions {
  deliveryId?: NativeAgentDeliveryId;
  projectId?: ProjectId;
  memberInstanceId?: string;
  triggerMessageId?: MessageId;
  providerSessionRef?: string | null;
  providerTurnId?: string | null;
  errorSummary?: string | null;
  createdAt?: string;
}

export function enqueueMeshAgentInboxItem(
  sqlite: Database,
  meshSessionId: string,
  messageSeq: number,
  createdAtOrOptions: string | EnqueueMeshAgentInboxOptions = new Date().toISOString()
): boolean {
  const options = typeof createdAtOrOptions === 'string' ? { createdAt: createdAtOrOptions } : createdAtOrOptions;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const deliveryId = options.deliveryId ?? newId('deliv');
  const result = sqlite
    .query(
      `INSERT OR IGNORE INTO mesh_agent_inbox_items
         (mesh_session_id, message_seq, delivery_id, project_id, member_instance_id, trigger_message_id,
          provider_session_ref, provider_turn_id, error_summary, state, created_at, updated_at)
       VALUES ($meshSessionId, $messageSeq, $deliveryId, $projectId, $memberInstanceId, $triggerMessageId,
          $providerSessionRef, $providerTurnId, $errorSummary, 'queued', $createdAt, $createdAt)`
    )
    .run({
      $meshSessionId: meshSessionId,
      $messageSeq: messageSeq,
      $deliveryId: deliveryId,
      $projectId: options.projectId ?? null,
      $memberInstanceId: options.memberInstanceId ?? null,
      $triggerMessageId: options.triggerMessageId ?? null,
      $providerSessionRef: options.providerSessionRef ?? null,
      $providerTurnId: options.providerTurnId ?? null,
      $errorSummary: options.errorSummary ?? null,
      $createdAt: createdAt
    });
  const identity = sqlite
    .query(
      `SELECT COALESCE(?, s.project_id) AS project_id,
              COALESCE(?, ms.agent_name) AS member_instance_id,
              COALESCE(?, m.id) AS message_id
       FROM mesh_sessions ms
       LEFT JOIN sessions s ON s.id = ms.transcript_target_id
       LEFT JOIN messages m ON m.rowid = ?
       WHERE ms.id = ?`
    )
    .get(
      options.projectId ?? null,
      options.memberInstanceId ?? null,
      options.triggerMessageId ?? null,
      messageSeq,
      meshSessionId
    ) as { project_id: ProjectId | null; member_instance_id: string | null; message_id: MessageId | null } | null;
  if (identity?.project_id && identity.member_instance_id && identity.message_id) {
    enqueueNativeAgentIngressItem(sqlite, {
      projectId: identity.project_id,
      memberInstanceId: identity.member_instance_id,
      meshSessionId,
      source: { kind: 'project', messageSeq, messageId: identity.message_id },
      deliveryId,
      providerSessionRef: options.providerSessionRef,
      providerTurnId: options.providerTurnId,
      errorSummary: options.errorSummary,
      createdAt
    });
  }
  return result.changes > 0;
}

// Delivered/visible/consumed advance the inbox-item state, the legacy mesh_sessions cursor, AND (for an
// owned managed runtime) the SessionBinding cursor in ONE transaction — the item state and both cursors
// can never diverge across a crash. A fenced (superseded/left) managed runtime is a no-op: it must not
// advance any cursor. An unowned managed runtime throws (invariant). The binding cursor advance is MAX,
// so a late writer never rewinds it.
export function markMeshAgentInboxDelivered(
  sqlite: Database,
  db: Db,
  meshSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  return sqlite.transaction(() => {
    const fence = fenceManagedDelivery(sqlite, db, meshSessionId);
    if (fence.kind === 'fenced') return false;
    const update = sqlite
      .query(
        `UPDATE mesh_agent_inbox_items
         SET state = CASE WHEN state = 'queued' THEN 'delivered' ELSE state END,
             delivered_at = COALESCE(delivered_at, ?),
             updated_at = ?
         WHERE mesh_session_id = ?
           AND message_seq <= ?
           AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, at, meshSessionId, cursor);
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = CASE WHEN state = 'queued' THEN 'delivered' ELSE state END,
             delivered_at = COALESCE(delivered_at, ?), updated_at = ?
         WHERE mesh_session_id = ? AND message_seq <= ? AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, at, meshSessionId, cursor);
    if (fence.kind === 'managed') {
      // The SessionBinding cursor is authoritative for a managed runtime; the legacy mesh_sessions cursor
      // is frozen (never advanced) so reads have a single source of truth.
      advanceSessionBindingDeliveredCursor(db, fence.sessionId, fence.owner, cursor, at);
      return update.changes > 0;
    }
    const cursorUpdated = setMeshAgentDeliveredCursor(sqlite, meshSessionId, cursor);
    return update.changes > 0 || cursorUpdated;
  })();
}

export function markMeshAgentInboxVisible(
  sqlite: Database,
  db: Db,
  meshSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  return sqlite.transaction(() => {
    const fence = fenceManagedDelivery(sqlite, db, meshSessionId);
    if (fence.kind === 'fenced') return false;
    const update = sqlite
      .query(
        `UPDATE mesh_agent_inbox_items
         SET state = CASE WHEN state IN ('queued', 'delivered') THEN 'visible' ELSE state END,
             visible_at = COALESCE(visible_at, ?),
             updated_at = ?
         WHERE mesh_session_id = ?
           AND message_seq <= ?
           AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, at, meshSessionId, cursor);
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = CASE WHEN state IN ('queued', 'delivered') THEN 'visible' ELSE state END,
             visible_at = COALESCE(visible_at, ?), updated_at = ?
         WHERE mesh_session_id = ? AND message_seq <= ? AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, at, meshSessionId, cursor);
    if (fence.kind === 'managed') {
      advanceSessionBindingVisibleCursor(db, fence.sessionId, fence.owner, cursor, at);
      return update.changes > 0;
    }
    const cursorUpdated = setMeshAgentVisibleCursor(sqlite, meshSessionId, cursor);
    return update.changes > 0 || cursorUpdated;
  })();
}

export function markMeshAgentInboxConsumed(
  sqlite: Database,
  db: Db,
  meshSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  return sqlite.transaction(() => {
    const fence = fenceManagedDelivery(sqlite, db, meshSessionId);
    if (fence.kind === 'fenced') return false;
    const update = sqlite
      .query(
        `UPDATE mesh_agent_inbox_items
         SET state = 'consumed',
             consumed_at = COALESCE(consumed_at, ?),
             updated_at = ?
         WHERE mesh_session_id = ?
           AND message_seq <= ?
           AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, at, meshSessionId, cursor);
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = 'consumed', consumed_at = COALESCE(consumed_at, ?), updated_at = ?
         WHERE mesh_session_id = ? AND message_seq <= ? AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, at, meshSessionId, cursor);
    if (fence.kind === 'managed') {
      advanceSessionBindingVisibleCursor(db, fence.sessionId, fence.owner, cursor, at);
      return update.changes > 0;
    }
    const visibleUpdated = setMeshAgentVisibleCursor(sqlite, meshSessionId, cursor);
    return update.changes > 0 || visibleUpdated;
  })();
}

export function hasUnconsumedMeshAgentInbox(sqlite: Database, db: Db, meshSessionId: string, cursor?: number): boolean {
  const resolved = resolveInboxCursor(sqlite, db, meshSessionId);
  if (!resolved) return false;
  const maxSeq = cursor ?? resolved.deliveredSeq;
  if (maxSeq <= 0) return false;
  const row = sqlite
    .query(
      `SELECT 1 AS found
       FROM mesh_agent_inbox_items
       WHERE mesh_session_id = ?
         AND message_seq <= ?
         AND state != 'consumed'
       LIMIT 1`
    )
    .get(meshSessionId, maxSeq) as { found: number } | null;
  return !!row;
}

export function listMeshAgentInbox(sqlite: Database, db: Db, meshSessionId: string, limit = 50): MeshAgentInboxItem[] {
  const resolved = resolveInboxCursor(sqlite, db, meshSessionId);
  if (!resolved) return [];
  const rows = sqlite
    .query(
      `SELECT m.*, i.message_seq AS _mesh_agent_seq, i.delivery_id AS _mesh_agent_delivery_id,
              i.state AS _mesh_agent_state
       FROM mesh_agent_inbox_items i
       JOIN messages m ON m.rowid = i.message_seq
       WHERE i.mesh_session_id = ?
         AND i.message_seq > ?
         AND i.state != 'consumed'
         AND m.active = 1
       ORDER BY i.message_seq ASC
       LIMIT ?`
    )
    .all(meshSessionId, resolved.visibleSeq, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    seq: row._mesh_agent_seq as number,
    deliveryId: (row._mesh_agent_delivery_id ?? undefined) as NativeAgentDeliveryId | undefined,
    deliveryState: row._mesh_agent_state as MeshAgentInboxDeliveryState,
    message: rowToMessage({
      id: row.id as string,
      transcriptTargetId: row.transcript_target_id as string,
      role: row.role as string,
      text: row.text as string,
      type: row.type as string,
      data: (row.data ?? null) as string | null,
      replyToMessageId: (row.reply_to_message_id ?? null) as string | null,
      streamStatus: row.stream_status as string,
      active: row.active as number,
      includeInContext: (row.include_in_context ?? null) as number | null,
      createdAt: row.created_at as string,
      updatedAt: (row.updated_at ?? null) as string | null
    } as MessageRow)
  }));
}

export function countMeshAgentInbox(sqlite: Database, db: Db, meshSessionId: string): number {
  const resolved = resolveInboxCursor(sqlite, db, meshSessionId);
  if (!resolved) return 0;
  const row = sqlite
    .query(
      `SELECT COUNT(*) AS count
       FROM mesh_agent_inbox_items i
       JOIN messages m ON m.rowid = i.message_seq
       WHERE i.mesh_session_id = ?
         AND i.message_seq > ?
         AND i.state != 'consumed'
         AND m.active = 1`
    )
    .get(meshSessionId, resolved.visibleSeq) as { count: number } | null;
  return row?.count ?? 0;
}

export function listMentionInbox(sqlite: Database, limit = 100): InboxItem[] {
  return listLegacyMentionInbox(sqlite, limit);
}

export function getNativeAgentDelivery(
  sqlite: Database,
  deliveryId: NativeAgentDeliveryId
): NativeAgentDelivery | null {
  const ingress = sqlite
    .query(
      `SELECT i.*, s.transcript_target_id, s.agent_name,
              s.provider_session_ref AS session_provider_session_ref
       FROM native_agent_ingress_items i
       LEFT JOIN mesh_sessions s ON s.id = i.mesh_session_id
       WHERE i.delivery_id = ?`
    )
    .get(deliveryId) as Record<string, unknown> | null;
  if (ingress) {
    const sessionId = ingress.transcript_target_id;
    if (typeof sessionId !== 'string' || !sessionId.startsWith('ses_')) return null;
    return nativeAgentDeliverySchema.parse({
      id: ingress.delivery_id,
      sessionId,
      memberInstanceId: ingress.member_instance_id ?? ingress.agent_name,
      meshSessionId: ingress.mesh_session_id,
      triggerMessageId: ingress.message_id ?? undefined,
      triggerMessageSeq: ingress.message_seq ?? 0,
      state: ingress.error_summary ? 'failed' : ingress.state,
      turn: {
        providerSessionRef: ingress.provider_session_ref ?? ingress.session_provider_session_ref ?? null,
        providerTurnId: ingress.provider_turn_id ?? null
      },
      errorSummary: ingress.error_summary ?? null,
      createdAt: ingress.created_at,
      updatedAt:
        ingress.updated_at ?? ingress.consumed_at ?? ingress.visible_at ?? ingress.delivered_at ?? ingress.created_at
    });
  }
  const row = sqlite
    .query(
      `SELECT i.*, s.transcript_target_id, s.agent_name, s.provider_session_ref AS session_provider_session_ref
       FROM mesh_agent_inbox_items i
       JOIN mesh_sessions s ON s.id = i.mesh_session_id
       WHERE i.delivery_id = ?`
    )
    .get(deliveryId) as Record<string, unknown> | null;
  if (!row) return null;
  const sessionId = (row.project_id ?? row.transcript_target_id) as string;
  if (!sessionId.startsWith('ses_')) return null;
  return nativeAgentDeliverySchema.parse({
    id: row.delivery_id,
    sessionId,
    memberInstanceId: row.member_instance_id ?? row.agent_name,
    meshSessionId: row.mesh_session_id,
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
