import type { Database } from 'bun:sqlite';
import type {
  InboxFilter,
  InboxItem,
  InboxSummary,
  ListInboxQuery,
  ListInboxResponse,
  MarkInboxReadResponse,
  ProjectId
} from '@monad/protocol';

import { meshSessionIdSchema, sessionIdSchema } from '@monad/protocol';

import { type MessageRow, rowToMessage } from './row-mappers.ts';

interface SourceRow extends Record<string, unknown> {
  _session_id: string;
  _project_id: string | null;
  _session_title: string | null;
  _project_name: string | null;
}

interface EventSourceRow extends SourceRow {
  type: string;
  payload: string;
  at: string;
  resolved_payload: string | null;
  resolved_at: string | null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function context(row: SourceRow, itemKey: string, reads: Map<string, string>) {
  return {
    itemKey,
    projectId: (row._project_id ?? undefined) as ProjectId | undefined,
    projectName: row._project_name ?? undefined,
    sessionId: sessionIdSchema.parse(row._session_id),
    sessionTitle: row._session_title ?? undefined,
    ...(reads.get(itemKey) ? { readAt: reads.get(itemKey) } : {})
  };
}

function readState(sqlite: Database): Map<string, string> {
  const rows = sqlite.query('SELECT item_key, read_at FROM inbox_item_reads').all() as Array<{
    item_key: string;
    read_at: string;
  }>;
  return new Map(rows.map((row) => [row.item_key, row.read_at]));
}

function mentionItems(sqlite: Database, reads: Map<string, string>): InboxItem[] {
  const rows = sqlite
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
        AND sm.member_id = CASE
          WHEN json_valid(m.data) THEN COALESCE(
            json_extract(m.data, '$.memberId'),
            json_extract(m.data, '$.agentId'),
            json_extract(m.data, '$.agentName')
          )
        END
       WHERE m.role = 'assistant'
         AND m.active = 1
         AND instr(m.text, 'id="human"') > 0`
    )
    .all() as SourceRow[];

  return rows.map((row) => {
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
    const data = parseRecord(row.data);
    if (!agentName && typeof data?.agentName === 'string') agentName = data.agentName;
    const itemKey = `mention:${message.id}`;
    return {
      ...context(row, itemKey, reads),
      kind: 'mention' as const,
      id: message.id,
      message,
      ...(agentName ? { agentName } : {}),
      actionState: 'informational' as const,
      createdAt: message.createdAt
    };
  });
}

function approvalItems(sqlite: Database, reads: Map<string, string>): InboxItem[] {
  const rows = sqlite
    .query(
      `SELECT e.type, e.payload, e.at,
              s.id AS _session_id,
              s.project_id AS _project_id,
              s.title AS _session_title,
              p.title AS _project_name,
              (SELECT r.payload FROM events r
                WHERE r.transcript_target_id = e.transcript_target_id
                  AND r.type = CASE e.type
                    WHEN 'tool.approval_requested' THEN 'tool.approval_resolved'
                    ELSE 'mesh.approval_resolved'
                  END
                  AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')
                ORDER BY r.rowid DESC LIMIT 1) AS resolved_payload,
              (SELECT r.at FROM events r
                WHERE r.transcript_target_id = e.transcript_target_id
                  AND r.type = CASE e.type
                    WHEN 'tool.approval_requested' THEN 'tool.approval_resolved'
                    ELSE 'mesh.approval_resolved'
                  END
                  AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')
                ORDER BY r.rowid DESC LIMIT 1) AS resolved_at
       FROM events e
       JOIN sessions s ON s.id = e.transcript_target_id
       LEFT JOIN workplace_projects p ON p.id = s.project_id
       WHERE e.type IN ('tool.approval_requested', 'mesh.approval_requested')`
    )
    .all() as EventSourceRow[];

  const items: InboxItem[] = [];
  for (const row of rows) {
    const payload = parseRecord(row.payload);
    if (!payload || typeof payload.requestId !== 'string') continue;
    const itemKey = `approval:${payload.requestId}`;
    const common = {
      ...context(row, itemKey, reads),
      kind: 'approval' as const,
      id: payload.requestId,
      actionState: row.resolved_at ? ('completed' as const) : ('needs-response' as const),
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
      createdAt: row.at
    };
    if (row.type === 'tool.approval_requested') {
      if (typeof payload.tool !== 'string') continue;
      items.push({
        ...common,
        approvalKind: 'tool',
        tool: payload.tool,
        input: payload.input,
        ...(typeof payload.key === 'string' ? { key: payload.key } : {})
      });
    } else if (typeof payload.meshSessionId === 'string') {
      items.push({
        ...common,
        approvalKind: 'mesh-agent',
        meshSessionId: meshSessionIdSchema.parse(payload.meshSessionId),
        ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
        ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
        input: payload.data
      });
    }
  }
  return items;
}

function hitlItems(sqlite: Database, reads: Map<string, string>): InboxItem[] {
  const rows = sqlite
    .query(
      `SELECT e.type, e.payload, e.at,
              s.id AS _session_id,
              s.project_id AS _project_id,
              s.title AS _session_title,
              p.title AS _project_name,
              (SELECT r.payload FROM events r
                WHERE r.transcript_target_id = e.transcript_target_id
                  AND r.type = 'clarify.resolved'
                  AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')
                ORDER BY r.rowid DESC LIMIT 1) AS resolved_payload,
              (SELECT r.at FROM events r
                WHERE r.transcript_target_id = e.transcript_target_id
                  AND r.type = 'clarify.resolved'
                  AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')
                ORDER BY r.rowid DESC LIMIT 1) AS resolved_at
       FROM events e
       JOIN sessions s ON s.id = e.transcript_target_id
       LEFT JOIN workplace_projects p ON p.id = s.project_id
       WHERE e.type = 'clarify.requested'`
    )
    .all() as EventSourceRow[];

  const items: InboxItem[] = [];
  for (const row of rows) {
    const payload = parseRecord(row.payload);
    if (!payload || typeof payload.requestId !== 'string' || typeof payload.question !== 'string') continue;
    const resolved = parseRecord(row.resolved_payload);
    const reason = resolved?.reason;
    const actionState = !row.resolved_at
      ? ('needs-response' as const)
      : reason === 'timeout'
        ? ('timed-out' as const)
        : reason === 'cancelled' || reason === 'aborted'
          ? ('cancelled' as const)
          : ('completed' as const);
    const itemKey = `hitl:${payload.requestId}`;
    items.push({
      ...context(row, itemKey, reads),
      kind: 'hitl',
      id: payload.requestId,
      requestId: payload.requestId,
      question: payload.question,
      ...(Array.isArray(payload.options) && payload.options.every((option) => typeof option === 'string')
        ? { options: payload.options as string[] }
        : {}),
      ...(payload.mode === 'single' || payload.mode === 'multiple' ? { mode: payload.mode } : {}),
      ...(typeof payload.allowOther === 'boolean' ? { allowOther: payload.allowOther } : {}),
      ...(payload.asker &&
      typeof payload.asker === 'object' &&
      typeof (payload.asker as Record<string, unknown>).name === 'string'
        ? {
            asker: {
              name: (payload.asker as Record<string, unknown>).name as string,
              ...(typeof (payload.asker as Record<string, unknown>).id === 'string'
                ? { id: (payload.asker as Record<string, unknown>).id as string }
                : {})
            }
          }
        : {}),
      ...(typeof payload.autoResolutionMs === 'number' ? { autoResolutionMs: payload.autoResolutionMs } : {}),
      ...(typeof payload.expiresAt === 'string' ? { expiresAt: payload.expiresAt } : {}),
      ...(typeof resolved?.answer === 'string' ? { answer: resolved.answer } : {}),
      ...(reason === 'timeout' || reason === 'cancelled' || reason === 'answered' ? { resolutionReason: reason } : {}),
      actionState,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
      createdAt: row.at
    });
  }
  return items;
}

function matchesFilter(item: InboxItem, filter: InboxFilter): boolean {
  if (filter === 'needs-response') return item.actionState === 'needs-response';
  if (filter === 'unread') return !item.readAt;
  if (filter === 'completed') return ['completed', 'timed-out', 'cancelled'].includes(item.actionState);
  return true;
}

function allItems(sqlite: Database): InboxItem[] {
  const reads = readState(sqlite);
  return [...mentionItems(sqlite, reads), ...approvalItems(sqlite, reads), ...hitlItems(sqlite, reads)].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.itemKey.localeCompare(a.itemKey)
  );
}

export function listOperatorInbox(sqlite: Database, query: ListInboxQuery = {}): ListInboxResponse {
  const filter = query.filter ?? 'all';
  const limit = query.limit ?? 100;
  let items = allItems(sqlite).filter((item) => matchesFilter(item, filter));
  if (query.cursor) {
    const index = items.findIndex((item) => `${item.createdAt}|${item.itemKey}` === query.cursor);
    if (index >= 0) items = items.slice(index + 1);
  }
  const page = items.slice(0, limit);
  return {
    items: page,
    ...(items.length > limit && page.length
      ? { nextCursor: `${page[page.length - 1]?.createdAt}|${page[page.length - 1]?.itemKey}` }
      : {})
  };
}

/** Compatibility projection for the original endpoint: mentions plus unresolved approvals only. */
export function listLegacyMentionInbox(sqlite: Database, limit = 100): InboxItem[] {
  return allItems(sqlite)
    .filter((item) => item.kind === 'mention' || (item.kind === 'approval' && item.actionState === 'needs-response'))
    .slice(0, limit);
}

export function operatorInboxSummary(sqlite: Database): InboxSummary {
  const items = allItems(sqlite);
  return {
    unreadCount: items.filter((item) => !item.readAt).length,
    needsResponseCount: items.filter((item) => item.actionState === 'needs-response').length
  };
}

export function markOperatorInboxRead(
  sqlite: Database,
  itemKeys: string[],
  readAt = new Date().toISOString()
): MarkInboxReadResponse {
  const insert = sqlite.query(
    `INSERT INTO inbox_item_reads (item_key, read_at) VALUES (?, ?)
     ON CONFLICT(item_key) DO UPDATE SET read_at = MIN(inbox_item_reads.read_at, excluded.read_at)`
  );
  sqlite.transaction((keys: string[]) => {
    for (const itemKey of new Set(keys)) insert.run(itemKey, readAt);
  })(itemKeys);
  return { itemKeys: [...new Set(itemKeys)], readAt };
}
