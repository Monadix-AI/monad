import type { Database } from 'bun:sqlite';
import type {
  MeshAgentInboxItem,
  MessageAttachmentRef,
  NativeAgentDeliveryId,
  NativeAgentPendingInboxItem,
  ProjectId
} from '@monad/protocol';

import { newId } from '@monad/protocol';

import { getNativeAgentDirectMessage } from './native-agent-messages.ts';
import { type MessageRow, rowToMessage } from './row-mappers.ts';

type NativeAgentIngressState = 'queued' | 'claimed' | 'delivered' | 'visible' | 'consumed' | 'failed';

type NativeAgentIngressSource =
  | { kind: 'project'; messageSeq: number; messageId: string }
  | { kind: 'direct'; directMessageId: string };

export interface EnqueueNativeAgentIngressInput {
  projectId: ProjectId | string;
  memberInstanceId: string;
  meshSessionId?: string;
  source: NativeAgentIngressSource;
  deliveryId?: NativeAgentDeliveryId;
  providerSessionRef?: string | null;
  providerTurnId?: string | null;
  errorSummary?: string | null;
  createdAt?: string;
}

export interface NativeAgentIngressItem {
  id: string;
  projectId: string;
  memberInstanceId: string;
  meshSessionId?: string;
  ingressSeq: number;
  source: NativeAgentIngressSource;
  deliveryId: NativeAgentDeliveryId;
  state: NativeAgentIngressState;
  claimBatchId?: string;
  createdAt: string;
}

interface IngressRow {
  id: string;
  project_id: string;
  member_instance_id: string;
  mesh_session_id: string | null;
  ingress_seq: number;
  source_kind: 'project' | 'direct';
  message_seq: number | null;
  message_id: string | null;
  direct_message_id: string | null;
  delivery_id: NativeAgentDeliveryId;
  state: NativeAgentIngressState;
  claim_batch_id: string | null;
  created_at: string;
}

function rowToIngressItem(row: IngressRow): NativeAgentIngressItem {
  const source: NativeAgentIngressSource =
    row.source_kind === 'project'
      ? { kind: 'project', messageSeq: row.message_seq ?? 0, messageId: row.message_id ?? '' }
      : { kind: 'direct', directMessageId: row.direct_message_id ?? '' };
  return {
    id: row.id,
    projectId: row.project_id,
    memberInstanceId: row.member_instance_id,
    ...(row.mesh_session_id === null ? {} : { meshSessionId: row.mesh_session_id }),
    ingressSeq: row.ingress_seq,
    source,
    deliveryId: row.delivery_id,
    state: row.state,
    ...(row.claim_batch_id === null ? {} : { claimBatchId: row.claim_batch_id }),
    createdAt: row.created_at
  };
}

function findExistingIngress(sqlite: Database, input: EnqueueNativeAgentIngressInput): IngressRow | null {
  if (input.source.kind === 'direct') {
    return sqlite
      .query('SELECT * FROM native_agent_ingress_items WHERE direct_message_id = ?')
      .get(input.source.directMessageId) as IngressRow | null;
  }
  return sqlite
    .query(
      `SELECT * FROM native_agent_ingress_items
       WHERE project_id = ? AND member_instance_id = ? AND message_id = ?`
    )
    .get(input.projectId, input.memberInstanceId, input.source.messageId) as IngressRow | null;
}

export function getNativeAgentIngressForDirectMessage(
  sqlite: Database,
  directMessageId: string
): NativeAgentIngressItem | null {
  const row = sqlite
    .query('SELECT * FROM native_agent_ingress_items WHERE direct_message_id = ?')
    .get(directMessageId) as IngressRow | null;
  return row ? rowToIngressItem(row) : null;
}

export function enqueueNativeAgentIngressItem(
  sqlite: Database,
  input: EnqueueNativeAgentIngressInput
): NativeAgentIngressItem {
  return sqlite.transaction(() => {
    const existing = findExistingIngress(sqlite, input);
    if (existing) return rowToIngressItem(existing);

    const at = input.createdAt ?? new Date().toISOString();
    sqlite
      .query(
        `INSERT OR IGNORE INTO mesh_agent_ingress_counters
           (project_id, member_instance_id, next_seq, updated_at)
         VALUES (?, ?, 1, ?)`
      )
      .run(input.projectId, input.memberInstanceId, at);
    const allocated = sqlite
      .query(
        `UPDATE mesh_agent_ingress_counters
         SET next_seq = next_seq + 1, updated_at = ?
         WHERE project_id = ? AND member_instance_id = ?
         RETURNING next_seq - 1 AS ingress_seq`
      )
      .get(at, input.projectId, input.memberInstanceId) as { ingress_seq: number } | null;
    if (!allocated) throw new Error('Failed to allocate managed-agent ingress sequence');

    const id = newId('ingress');
    const deliveryId = input.deliveryId ?? newId('deliv');
    sqlite
      .query(
        `INSERT INTO native_agent_ingress_items
           (id, project_id, member_instance_id, mesh_session_id, ingress_seq, source_kind,
            message_seq, message_id, direct_message_id, delivery_id, state, provider_session_ref,
            provider_turn_id, error_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.memberInstanceId,
        input.meshSessionId ?? null,
        allocated.ingress_seq,
        input.source.kind,
        input.source.kind === 'project' ? input.source.messageSeq : null,
        input.source.kind === 'project' ? input.source.messageId : null,
        input.source.kind === 'direct' ? input.source.directMessageId : null,
        deliveryId,
        input.providerSessionRef ?? null,
        input.providerTurnId ?? null,
        input.errorSummary ?? null,
        at,
        at
      );
    const inserted = sqlite.query('SELECT * FROM native_agent_ingress_items WHERE id = ?').get(id) as IngressRow | null;
    if (!inserted) throw new Error(`Failed to persist managed-agent ingress item ${id}`);
    return rowToIngressItem(inserted);
  })();
}

export function bindNativeAgentIngressDelivery(
  sqlite: Database,
  deliveryId: NativeAgentDeliveryId,
  meshSessionId: string,
  providerSessionRef?: string | null,
  at = new Date().toISOString()
): boolean {
  return (
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET mesh_session_id = ?, provider_session_ref = COALESCE(?, provider_session_ref), updated_at = ?
         WHERE delivery_id = ?`
      )
      .run(meshSessionId, providerSessionRef ?? null, at, deliveryId).changes > 0
  );
}

export function markNativeAgentIngressVisible(
  sqlite: Database,
  itemIds: string[],
  at = new Date().toISOString()
): void {
  const update = sqlite.query(
    `UPDATE native_agent_ingress_items
     SET state = 'visible', visible_at = COALESCE(visible_at, ?), updated_at = ?
     WHERE id = ? AND state IN ('queued', 'delivered', 'visible')`
  );
  sqlite.transaction(() => {
    for (const itemId of itemIds) update.run(at, at, itemId);
  })();
}

export function listNativeAgentProjectInbox(
  sqlite: Database,
  projectId: string,
  sessionId: string,
  memberInstanceId: string,
  limit = 50,
  at = new Date().toISOString()
): MeshAgentInboxItem[] {
  return sqlite.transaction(() => {
    const rows = sqlite
      .query(
        `SELECT m.*, i.id AS _ingress_id, i.message_seq AS _mesh_agent_seq,
                i.delivery_id AS _mesh_agent_delivery_id, i.state AS _mesh_agent_state
         FROM native_agent_ingress_items i
         JOIN messages m ON m.rowid = i.message_seq
         WHERE i.project_id = ? AND i.member_instance_id = ? AND i.source_kind = 'project'
           AND m.transcript_target_id = ? AND i.state IN ('queued', 'delivered') AND m.active = 1
         ORDER BY i.ingress_seq
         LIMIT ?`
      )
      .all(projectId, memberInstanceId, sessionId, limit) as Array<Record<string, unknown>>;
    markNativeAgentIngressVisible(
      sqlite,
      rows.map((row) => row._ingress_id as string),
      at
    );
    return rows.map((row) => ({
      seq: row._mesh_agent_seq as number,
      deliveryId: (row._mesh_agent_delivery_id ?? undefined) as NativeAgentDeliveryId | undefined,
      deliveryState: row._mesh_agent_state as 'queued' | 'delivered' | 'visible' | 'consumed',
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
  })();
}

export function consumeNativeAgentPendingInbox(
  sqlite: Database,
  projectId: string,
  sessionId: string,
  memberInstanceId: string,
  limit = 50,
  at = new Date().toISOString()
): NativeAgentPendingInboxItem[] {
  return sqlite.transaction(() => {
    const rows = sqlite
      .query(
        `SELECT i.* FROM native_agent_ingress_items i
         LEFT JOIN messages m ON m.rowid = i.message_seq
         LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
         WHERE i.project_id = ? AND i.member_instance_id = ?
           AND COALESCE(m.transcript_target_id, d.session_id) = ?
           AND i.state IN ('queued', 'delivered')
         ORDER BY i.ingress_seq
         LIMIT ?`
      )
      .all(projectId, memberInstanceId, sessionId, limit) as IngressRow[];
    if (rows.length === 0) return [];
    const consume = sqlite.query(
      `UPDATE native_agent_ingress_items
       SET state = 'consumed', consumed_at = COALESCE(consumed_at, ?), updated_at = ?
       WHERE id = ? AND state IN ('queued', 'delivered')`
    );
    const items: NativeAgentPendingInboxItem[] = [];
    for (const row of rows) {
      if (row.source_kind === 'project') {
        const raw = sqlite
          .query('SELECT * FROM messages WHERE rowid = ? AND active = 1')
          .get(row.message_seq) as Record<string, unknown> | null;
        const message = raw
          ? ({
              id: raw.id as string,
              transcriptTargetId: raw.transcript_target_id as string,
              role: raw.role as string,
              text: raw.text as string,
              type: raw.type as string,
              data: (raw.data ?? null) as string | null,
              replyToMessageId: (raw.reply_to_message_id ?? null) as string | null,
              streamStatus: raw.stream_status as string,
              active: raw.active as number,
              includeInContext: (raw.include_in_context ?? null) as number | null,
              createdAt: raw.created_at as string,
              updatedAt: (raw.updated_at ?? null) as string | null
            } as MessageRow)
          : null;
        if (message) {
          items.push({
            source: 'project',
            ingressSeq: row.ingress_seq,
            messageSeq: row.message_seq ?? 0,
            deliveryId: row.delivery_id,
            createdAt: message.createdAt,
            message: rowToMessage(message)
          });
        }
      } else if (row.direct_message_id) {
        const message = getNativeAgentDirectMessage(sqlite, row.direct_message_id);
        if (message) {
          items.push({
            source: 'direct',
            ingressSeq: row.ingress_seq,
            deliveryId: row.delivery_id,
            createdAt: message.createdAt,
            message
          });
        }
      }
      consume.run(at, at, row.id);
    }
    return items;
  })();
}

export interface ClaimNativeAgentIngressBatchInput {
  id: string;
  projectId: string;
  sessionId: string;
  memberInstanceId: string;
  askRequestId?: string;
  createdAt?: string;
}

export interface ClaimedNativeAgentIngressBatch {
  id: string;
  highWaterSeq: number;
  itemIds: string[];
}

type NativeAgentRecoveryBatchState = 'claimed' | 'delivered' | 'consumed' | 'released';

export interface NativeAgentRecoveryBatch extends ClaimedNativeAgentIngressBatch {
  state: NativeAgentRecoveryBatchState;
}

export type ClaimedNativeAgentIngressItem =
  | {
      ingressSeq: number;
      source: 'project';
      deliveryId: NativeAgentDeliveryId;
      text: string;
      createdAt: string;
      messageSeq: number;
      messageId: string;
      replyToMessageId?: string;
      sender: { kind: 'human' | 'mesh-agent' | 'agent' | 'system'; name: string; id?: string };
      attachments?: MessageAttachmentRef[];
    }
  | {
      ingressSeq: number;
      source: 'direct';
      deliveryId: NativeAgentDeliveryId;
      text: string;
      createdAt: string;
      directMessageId: string;
      fromAgent: string | null;
      peer: string;
      attachments?: MessageAttachmentRef[];
    };

export function claimNativeAgentIngressBatch(
  sqlite: Database,
  input: ClaimNativeAgentIngressBatchInput
): ClaimedNativeAgentIngressBatch {
  return sqlite.transaction(() => {
    const existing = sqlite
      .query('SELECT high_water_seq FROM native_agent_recovery_batches WHERE id = ?')
      .get(input.id) as { high_water_seq: number } | null;
    if (existing) {
      const items = sqlite
        .query('SELECT id FROM native_agent_ingress_items WHERE claim_batch_id = ? ORDER BY ingress_seq')
        .all(input.id) as Array<{ id: string }>;
      return { id: input.id, highWaterSeq: existing.high_water_seq, itemIds: items.map((item) => item.id) };
    }

    const highWater = sqlite
      .query(
        `SELECT COALESCE(MAX(i.ingress_seq), 0) AS high_water_seq
         FROM native_agent_ingress_items i
         LEFT JOIN messages m ON m.rowid = i.message_seq
         LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
         WHERE i.project_id = ? AND i.member_instance_id = ?
           AND COALESCE(m.transcript_target_id, d.session_id) = ?`
      )
      .get(input.projectId, input.memberInstanceId, input.sessionId) as { high_water_seq: number };
    const at = input.createdAt ?? new Date().toISOString();
    sqlite
      .query(
        `INSERT INTO native_agent_recovery_batches
           (id, project_id, member_instance_id, ask_request_id, high_water_seq, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)`
      )
      .run(
        input.id,
        input.projectId,
        input.memberInstanceId,
        input.askRequestId ?? null,
        highWater.high_water_seq,
        at,
        at
      );
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = 'claimed', claim_batch_id = ?, updated_at = ?
         WHERE id IN (
           SELECT i.id
           FROM native_agent_ingress_items i
           LEFT JOIN messages m ON m.rowid = i.message_seq
           LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
           WHERE i.project_id = ? AND i.member_instance_id = ?
             AND COALESCE(m.transcript_target_id, d.session_id) = ?
             AND i.ingress_seq <= ? AND i.state IN ('queued', 'delivered')
         )`
      )
      .run(input.id, at, input.projectId, input.memberInstanceId, input.sessionId, highWater.high_water_seq);
    const items = sqlite
      .query('SELECT id FROM native_agent_ingress_items WHERE claim_batch_id = ? ORDER BY ingress_seq')
      .all(input.id) as Array<{ id: string }>;
    return { id: input.id, highWaterSeq: highWater.high_water_seq, itemIds: items.map((item) => item.id) };
  })();
}

export function claimNextNativeAgentIngressBatch(
  sqlite: Database,
  input: Omit<ClaimNativeAgentIngressBatchInput, 'id'> & { askRequestId: string }
): NativeAgentRecoveryBatch {
  return sqlite.transaction((): NativeAgentRecoveryBatch => {
    const active = sqlite
      .query(
        `SELECT id, high_water_seq, state
         FROM native_agent_recovery_batches
         WHERE ask_request_id = ? AND state IN ('claimed', 'delivered', 'released')
         ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(input.askRequestId) as {
      id: string;
      high_water_seq: number;
      state: NativeAgentRecoveryBatchState;
    } | null;
    if (active) {
      if (active.state === 'released') {
        const at = input.createdAt ?? new Date().toISOString();
        sqlite
          .query("UPDATE native_agent_recovery_batches SET state = 'claimed', updated_at = ? WHERE id = ?")
          .run(at, active.id);
        sqlite
          .query(
            `UPDATE native_agent_ingress_items
             SET state = 'claimed', claim_batch_id = ?, updated_at = ?
             WHERE id IN (
               SELECT i.id
               FROM native_agent_ingress_items i
               LEFT JOIN messages m ON m.rowid = i.message_seq
               LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
               WHERE i.project_id = ? AND i.member_instance_id = ?
                 AND COALESCE(m.transcript_target_id, d.session_id) = ?
                 AND i.ingress_seq <= ? AND i.state IN ('queued', 'delivered')
             )`
          )
          .run(active.id, at, input.projectId, input.memberInstanceId, input.sessionId, active.high_water_seq);
      }
      const items = sqlite
        .query('SELECT id FROM native_agent_ingress_items WHERE claim_batch_id = ? ORDER BY ingress_seq')
        .all(active.id) as Array<{ id: string }>;
      return {
        id: active.id,
        highWaterSeq: active.high_water_seq,
        itemIds: items.map((item) => item.id),
        state: active.state === 'released' ? 'claimed' : active.state
      };
    }

    const count = sqlite
      .query('SELECT COUNT(*) AS count FROM native_agent_recovery_batches WHERE ask_request_id = ?')
      .get(input.askRequestId) as { count: number };
    const batch = claimNativeAgentIngressBatch(sqlite, {
      ...input,
      id: `recovery:${input.askRequestId}:${count.count + 1}`
    });
    return { ...batch, state: 'claimed' };
  })();
}

export function markNativeAgentIngressBatchDelivered(
  sqlite: Database,
  batchId: string,
  at = new Date().toISOString()
): boolean {
  return (
    sqlite
      .query(
        "UPDATE native_agent_recovery_batches SET state = 'delivered', updated_at = ? WHERE id = ? AND state = 'claimed'"
      )
      .run(at, batchId).changes > 0
  );
}

export function listClaimedNativeAgentIngress(sqlite: Database, batchId: string): ClaimedNativeAgentIngressItem[] {
  const rows = sqlite
    .query(
      `SELECT i.ingress_seq, i.source_kind, i.delivery_id, i.message_seq, i.message_id, i.direct_message_id,
              m.text AS message_text, m.created_at AS message_created_at,
              m.role AS message_role, m.data AS message_data, m.reply_to_message_id,
              d.text AS direct_text, d.created_at AS direct_created_at,
              d.from_agent, d.peer
       FROM native_agent_ingress_items i
       LEFT JOIN messages m ON m.rowid = i.message_seq
       LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
       WHERE i.claim_batch_id = ? AND i.state = 'claimed'
       ORDER BY i.ingress_seq`
    )
    .all(batchId) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (row.source_kind === 'direct') {
      const direct = getNativeAgentDirectMessage(sqlite, row.direct_message_id as string);
      return {
        ingressSeq: row.ingress_seq as number,
        source: 'direct' as const,
        deliveryId: row.delivery_id as NativeAgentDeliveryId,
        text: row.direct_text as string,
        createdAt: row.direct_created_at as string,
        directMessageId: row.direct_message_id as string,
        fromAgent: (row.from_agent as string | null) ?? null,
        peer: row.peer as string,
        ...(direct?.attachments?.length ? { attachments: direct.attachments } : {})
      };
    }
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((row.message_data as string | null) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {}
    const agentName = typeof data.agentName === 'string' ? data.agentName : undefined;
    const displayName = typeof data.agentDisplayName === 'string' ? data.agentDisplayName : agentName;
    const humanDisplayName =
      typeof data.humanDisplayName === 'string' && data.humanDisplayName.trim()
        ? data.humanDisplayName.trim()
        : undefined;
    const role = row.message_role as string;
    const sender = agentName
      ? { kind: 'mesh-agent' as const, name: displayName ?? agentName, id: agentName }
      : role === 'user'
        ? { kind: 'human' as const, name: humanDisplayName ?? 'User', id: 'human' }
        : role === 'system'
          ? { kind: 'system' as const, name: 'System' }
          : { kind: 'agent' as const, name: displayName ?? 'Agent' };
    const attachments = Array.isArray(data.attachments) ? (data.attachments as MessageAttachmentRef[]) : undefined;
    return {
      ingressSeq: row.ingress_seq as number,
      source: 'project' as const,
      deliveryId: row.delivery_id as NativeAgentDeliveryId,
      text: row.message_text as string,
      createdAt: row.message_created_at as string,
      messageSeq: row.message_seq as number,
      messageId: row.message_id as string,
      ...((row.reply_to_message_id as string | null) ? { replyToMessageId: row.reply_to_message_id as string } : {}),
      sender,
      ...(attachments?.length ? { attachments } : {})
    };
  });
}

export interface AcknowledgeVisibleNativeAgentIngressInput {
  projectId: string;
  sessionId: string;
  memberInstanceId: string;
  requestedCursor: number;
  at?: string;
}

export interface AcknowledgeVisibleNativeAgentIngressResult {
  requestedCursor: number;
  visibleCursor: number;
  consumedDeliveryIds: NativeAgentDeliveryId[];
  deferredDeliveryIds: NativeAgentDeliveryId[];
}

export function acknowledgeVisibleNativeAgentIngress(
  sqlite: Database,
  input: AcknowledgeVisibleNativeAgentIngressInput
): AcknowledgeVisibleNativeAgentIngressResult {
  return sqlite.transaction(() => {
    const rows = sqlite
      .query(
        `SELECT i.id, i.message_seq, i.delivery_id, i.state
         FROM native_agent_ingress_items i
         JOIN messages m ON m.rowid = i.message_seq
         WHERE i.project_id = ? AND i.member_instance_id = ? AND i.source_kind = 'project'
           AND m.transcript_target_id = ? AND i.message_seq <= ? AND i.state IN ('visible', 'claimed')
         ORDER BY i.message_seq`
      )
      .all(input.projectId, input.memberInstanceId, input.sessionId, input.requestedCursor) as Array<{
      id: string;
      message_seq: number;
      delivery_id: NativeAgentDeliveryId;
      state: 'visible' | 'claimed';
    }>;
    const visible = rows.filter((row) => row.state === 'visible');
    const claimed = rows.filter((row) => row.state === 'claimed');
    const at = input.at ?? new Date().toISOString();
    const consume = sqlite.query(
      `UPDATE native_agent_ingress_items
       SET state = 'consumed', consumed_at = COALESCE(consumed_at, ?), updated_at = ?
       WHERE id = ? AND state = 'visible'`
    );
    for (const row of visible) consume.run(at, at, row.id);

    const firstClaimedSeq = claimed[0]?.message_seq;
    const visibleCursor =
      firstClaimedSeq === undefined
        ? input.requestedCursor
        : (visible.filter((row) => row.message_seq < firstClaimedSeq).at(-1)?.message_seq ?? 0);
    return {
      requestedCursor: input.requestedCursor,
      visibleCursor,
      consumedDeliveryIds: visible.map((row) => row.delivery_id),
      deferredDeliveryIds: claimed.map((row) => row.delivery_id)
    };
  })();
}

export function consumeNativeAgentIngressBatch(sqlite: Database, batchId: string, at = new Date().toISOString()): void {
  sqlite.transaction(() => {
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = 'consumed', consumed_at = COALESCE(consumed_at, ?), updated_at = ?
         WHERE claim_batch_id = ? AND state = 'claimed'`
      )
      .run(at, at, batchId);
    sqlite
      .query("UPDATE native_agent_recovery_batches SET state = 'consumed', updated_at = ? WHERE id = ?")
      .run(at, batchId);
  })();
}

export function releaseNativeAgentIngressBatch(sqlite: Database, batchId: string, at = new Date().toISOString()): void {
  sqlite.transaction(() => {
    sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = 'queued', claim_batch_id = NULL, updated_at = ?
         WHERE claim_batch_id = ? AND state = 'claimed'`
      )
      .run(at, batchId);
    sqlite
      .query("UPDATE native_agent_recovery_batches SET state = 'released', updated_at = ? WHERE id = ?")
      .run(at, batchId);
  })();
}

export function reconcileNativeAgentIngressAfterRestart(
  sqlite: Database,
  at = new Date().toISOString()
): { consumed: number; released: number } {
  return sqlite.transaction(() => {
    const consumed = sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = 'consumed', consumed_at = COALESCE(consumed_at, ?), updated_at = ?
         WHERE state = 'claimed' AND claim_batch_id IN (
           SELECT id FROM native_agent_recovery_batches WHERE state = 'delivered'
         )`
      )
      .run(at, at).changes;
    sqlite
      .query("UPDATE native_agent_recovery_batches SET state = 'consumed', updated_at = ? WHERE state = 'delivered'")
      .run(at);
    const released = sqlite
      .query(
        `UPDATE native_agent_ingress_items
         SET state = 'queued', claim_batch_id = NULL, updated_at = ?
         WHERE state = 'claimed'`
      )
      .run(at).changes;
    sqlite
      .query("UPDATE native_agent_recovery_batches SET state = 'released', updated_at = ? WHERE state = 'claimed'")
      .run(at);
    return { consumed, released };
  })();
}

export interface PendingNativeAgentIngressTarget {
  projectId: string;
  memberInstanceId: string;
  sessionId: string;
  source: NativeAgentIngressSource;
}

export function listPendingNativeAgentIngressTargets(sqlite: Database): PendingNativeAgentIngressTarget[] {
  const rows = sqlite
    .query(
      `SELECT project_id, member_instance_id, source_kind, message_seq, message_id, direct_message_id, session_id
       FROM (
         SELECT i.project_id, i.member_instance_id, i.source_kind, i.message_seq, i.message_id,
                i.direct_message_id, COALESCE(m.transcript_target_id, d.session_id) AS session_id,
                ROW_NUMBER() OVER (
                  PARTITION BY i.project_id, i.member_instance_id, COALESCE(m.transcript_target_id, d.session_id)
                  ORDER BY i.ingress_seq
                ) AS position
         FROM native_agent_ingress_items i
         LEFT JOIN messages m ON m.rowid = i.message_seq
         LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
         WHERE i.state IN ('queued', 'delivered')
       )
       WHERE position = 1 AND session_id IS NOT NULL`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    projectId: row.project_id as string,
    memberInstanceId: row.member_instance_id as string,
    sessionId: row.session_id as string,
    source:
      row.source_kind === 'project'
        ? {
            kind: 'project',
            messageSeq: row.message_seq as number,
            messageId: row.message_id as string
          }
        : { kind: 'direct', directMessageId: row.direct_message_id as string }
  }));
}
