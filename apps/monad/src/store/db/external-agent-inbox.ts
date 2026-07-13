// External agent inbox: the queued/delivered/visible/consumed lifecycle of messages routed to a native
// CLI session, plus the delivery-record projection. Split out of index.ts — every function takes the
// raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type {
  ExternalAgentInboxDeliveryState,
  ExternalAgentInboxItem,
  InboxItem,
  MessageId,
  NativeAgentDelivery,
  NativeAgentDeliveryId,
  ProjectId
} from '@monad/protocol';

import { externalAgentSessionIdSchema, nativeAgentDeliverySchema, newId, sessionIdSchema } from '@monad/protocol';

import {
  getExternalAgentSession,
  setExternalAgentDeliveredCursor,
  setExternalAgentVisibleCursor
} from './external-agent-sessions.ts';
import { type MessageRow, rowToMessage } from './row-mappers.ts';

export interface EnqueueExternalAgentInboxOptions {
  deliveryId?: NativeAgentDeliveryId;
  projectId?: ProjectId;
  memberInstanceId?: string;
  triggerMessageId?: MessageId;
  providerSessionRef?: string | null;
  providerTurnId?: string | null;
  errorSummary?: string | null;
  createdAt?: string;
}

export function enqueueExternalAgentInboxItem(
  sqlite: Database,
  externalAgentSessionId: string,
  messageSeq: number,
  createdAtOrOptions: string | EnqueueExternalAgentInboxOptions = new Date().toISOString()
): boolean {
  const options = typeof createdAtOrOptions === 'string' ? { createdAt: createdAtOrOptions } : createdAtOrOptions;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const result = sqlite
    .query(
      `INSERT OR IGNORE INTO external_agent_inbox_items
         (external_agent_session_id, message_seq, delivery_id, project_id, member_instance_id, trigger_message_id,
          provider_session_ref, provider_turn_id, error_summary, state, created_at, updated_at)
       VALUES ($externalAgentSessionId, $messageSeq, $deliveryId, $projectId, $memberInstanceId, $triggerMessageId,
          $providerSessionRef, $providerTurnId, $errorSummary, 'queued', $createdAt, $createdAt)`
    )
    .run({
      $externalAgentSessionId: externalAgentSessionId,
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

export function markExternalAgentInboxDelivered(
  sqlite: Database,
  externalAgentSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  const update = sqlite
    .query(
      `UPDATE external_agent_inbox_items
       SET state = CASE WHEN state = 'queued' THEN 'delivered' ELSE state END,
           delivered_at = COALESCE(delivered_at, ?),
           updated_at = ?
       WHERE external_agent_session_id = ?
         AND message_seq <= ?
         AND state IN ('queued', 'delivered', 'visible')`
    )
    .run(at, at, externalAgentSessionId, cursor);
  const cursorUpdated = setExternalAgentDeliveredCursor(sqlite, externalAgentSessionId, cursor);
  return update.changes > 0 || cursorUpdated;
}

export function markExternalAgentInboxVisible(
  sqlite: Database,
  externalAgentSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  const update = sqlite
    .query(
      `UPDATE external_agent_inbox_items
       SET state = CASE WHEN state IN ('queued', 'delivered') THEN 'visible' ELSE state END,
           visible_at = COALESCE(visible_at, ?),
           updated_at = ?
       WHERE external_agent_session_id = ?
         AND message_seq <= ?
         AND state IN ('queued', 'delivered', 'visible')`
    )
    .run(at, at, externalAgentSessionId, cursor);
  const cursorUpdated = setExternalAgentVisibleCursor(sqlite, externalAgentSessionId, cursor);
  return update.changes > 0 || cursorUpdated;
}

export function markExternalAgentInboxConsumed(
  sqlite: Database,
  externalAgentSessionId: string,
  cursor: number,
  at = new Date().toISOString()
): boolean {
  const update = sqlite
    .query(
      `UPDATE external_agent_inbox_items
       SET state = 'consumed',
           consumed_at = COALESCE(consumed_at, ?),
           updated_at = ?
       WHERE external_agent_session_id = ?
         AND message_seq <= ?
         AND state IN ('queued', 'delivered', 'visible')`
    )
    .run(at, at, externalAgentSessionId, cursor);
  const visibleUpdated = setExternalAgentVisibleCursor(sqlite, externalAgentSessionId, cursor);
  return update.changes > 0 || visibleUpdated;
}

export function hasUnconsumedExternalAgentInbox(
  sqlite: Database,
  externalAgentSessionId: string,
  cursor?: number
): boolean {
  const session = getExternalAgentSession(sqlite, externalAgentSessionId);
  if (!session) return false;
  const maxSeq = cursor ?? session.lastDeliveredSeq;
  if (maxSeq <= 0) return false;
  const row = sqlite
    .query(
      `SELECT 1 AS found
       FROM external_agent_inbox_items
       WHERE external_agent_session_id = ?
         AND message_seq <= ?
         AND state != 'consumed'
       LIMIT 1`
    )
    .get(externalAgentSessionId, maxSeq) as { found: number } | null;
  return !!row;
}

export function listExternalAgentInbox(
  sqlite: Database,
  externalAgentSessionId: string,
  limit = 50
): ExternalAgentInboxItem[] {
  const session = getExternalAgentSession(sqlite, externalAgentSessionId);
  if (!session) return [];
  const rows = sqlite
    .query(
      `SELECT m.*, i.message_seq AS _external_agent_seq, i.delivery_id AS _external_agent_delivery_id,
              i.state AS _external_agent_state
       FROM external_agent_inbox_items i
       JOIN messages m ON m.rowid = i.message_seq
       WHERE i.external_agent_session_id = ?
         AND i.message_seq > ?
         AND i.state != 'consumed'
         AND m.active = 1
       ORDER BY i.message_seq ASC
       LIMIT ?`
    )
    .all(externalAgentSessionId, session.lastVisibleSeq, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    seq: row._external_agent_seq as number,
    deliveryId: (row._external_agent_delivery_id ?? undefined) as NativeAgentDeliveryId | undefined,
    deliveryState: row._external_agent_state as ExternalAgentInboxDeliveryState,
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

export function countExternalAgentInbox(sqlite: Database, externalAgentSessionId: string): number {
  const session = getExternalAgentSession(sqlite, externalAgentSessionId);
  if (!session) return 0;
  const row = sqlite
    .query(
      `SELECT COUNT(*) AS count
       FROM external_agent_inbox_items i
       JOIN messages m ON m.rowid = i.message_seq
       WHERE i.external_agent_session_id = ?
         AND i.message_seq > ?
         AND i.state != 'consumed'
         AND m.active = 1`
    )
    .get(externalAgentSessionId, session.lastVisibleSeq) as { count: number } | null;
  return row?.count ?? 0;
}

export function listMentionInbox(sqlite: Database, limit = 100): InboxItem[] {
  const mentionRows = sqlite
    .query(
      `SELECT m.*,
              s.id AS _session_id,
              s.project_id AS _project_id,
              s.title AS _session_title,
              p.title AS _project_name,
              COALESCE(json_extract(sm.data, '$.displayName'), json_extract(sm.data, '$.name')) AS _agent_display_name
       FROM messages m
       JOIN sessions s ON s.id = m.transcript_target_id
       LEFT JOIN workplace_projects p ON p.id = s.project_id
       LEFT JOIN session_members sm
         ON sm.session_id = s.id
        AND sm.member_id = CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.agentName') END
       WHERE m.role = 'assistant'
         AND m.active = 1
         AND instr(m.text, 'id="human"') > 0
       ORDER BY m.rowid DESC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  const mentions: InboxItem[] = mentionRows.map((row) => {
    const message = rowToMessage({
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
    } as MessageRow);
    let agentName = typeof row._agent_display_name === 'string' ? row._agent_display_name : undefined;
    if (typeof row.data === 'string') {
      try {
        const data = JSON.parse(row.data) as { agentName?: unknown };
        if (!agentName && typeof data.agentName === 'string') agentName = data.agentName;
      } catch {
        // Invalid message metadata must not hide an otherwise valid mention.
      }
    }
    return {
      kind: 'mention',
      id: message.id,
      projectId: (row._project_id ?? undefined) as ProjectId | undefined,
      projectName: (row._project_name ?? undefined) as string | undefined,
      sessionId: sessionIdSchema.parse(row._session_id),
      sessionTitle: (row._session_title ?? undefined) as string | undefined,
      message,
      ...(agentName ? { agentName } : {}),
      createdAt: message.createdAt
    };
  });

  const approvalRows = sqlite
    .query(
      `SELECT e.type, e.payload, e.at,
              s.id AS _session_id,
              s.project_id AS _project_id,
              s.title AS _session_title,
              p.title AS _project_name
       FROM events e
       JOIN sessions s ON s.id = e.transcript_target_id
       LEFT JOIN workplace_projects p ON p.id = s.project_id
       WHERE e.type IN ('tool.approval_requested', 'external_agent.approval_requested')
         AND NOT EXISTS (
           SELECT 1 FROM events r
           WHERE r.transcript_target_id = e.transcript_target_id
             AND r.type = CASE e.type
               WHEN 'tool.approval_requested' THEN 'tool.approval_resolved'
               ELSE 'external_agent.approval_resolved'
             END
             AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')
         )
       ORDER BY e.rowid DESC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  const approvals: InboxItem[] = [];
  for (const row of approvalRows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof payload.requestId !== 'string') continue;
    const context = {
      projectId: (row._project_id ?? undefined) as ProjectId | undefined,
      projectName: (row._project_name ?? undefined) as string | undefined,
      sessionId: sessionIdSchema.parse(row._session_id),
      sessionTitle: (row._session_title ?? undefined) as string | undefined,
      createdAt: String(row.at)
    };
    if (row.type === 'tool.approval_requested') {
      if (typeof payload.tool !== 'string') continue;
      approvals.push({
        kind: 'approval',
        id: payload.requestId,
        approvalKind: 'tool',
        tool: payload.tool,
        input: payload.input,
        ...(typeof payload.key === 'string' ? { key: payload.key } : {}),
        ...context
      });
      continue;
    }
    if (typeof payload.externalAgentSessionId !== 'string') continue;
    approvals.push({
      kind: 'approval',
      id: payload.requestId,
      approvalKind: 'external-agent',
      externalAgentSessionId: externalAgentSessionIdSchema.parse(payload.externalAgentSessionId),
      ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
      ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
      input: payload.data,
      ...context
    });
  }

  return [...mentions, ...approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function getNativeAgentDelivery(
  sqlite: Database,
  deliveryId: NativeAgentDeliveryId
): NativeAgentDelivery | null {
  const row = sqlite
    .query(
      `SELECT i.*, s.transcript_target_id, s.agent_name, s.provider_session_ref AS session_provider_session_ref
       FROM external_agent_inbox_items i
       JOIN external_agent_sessions s ON s.id = i.external_agent_session_id
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
    externalAgentSessionId: row.external_agent_session_id,
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
