// Native agent direct messages: peer-to-peer messages between external agents within a project.
// Split out of index.ts — every function takes the raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type { MessageAttachmentRef, NativeAgentDirectMessage } from '@monad/protocol';

import { getMessageAttachmentRefs, parseAttachmentIds } from './attachments.ts';
import { getExternalAgentSession } from './external-agent-sessions.ts';

export function insertNativeAgentDirectMessage(sqlite: Database, row: NativeAgentDirectMessage): void {
  sqlite
    .query(
      `INSERT INTO native_agent_direct_messages
        (id, project_id, external_agent_session_id, from_agent, peer, text, attachment_ids, created_at)
       VALUES ($id, $projectId, $externalAgentSessionId, $fromAgent, $peer, $text, $attachmentIds, $createdAt)`
    )
    .run({
      $id: row.id,
      $projectId: row.sessionId,
      $externalAgentSessionId: row.externalAgentSessionId,
      $fromAgent: row.fromAgent,
      $peer: row.peer,
      $text: row.text,
      $attachmentIds: row.attachments?.length ? JSON.stringify(row.attachments.map((a) => a.id)) : null,
      $createdAt: row.createdAt
    });
}

export function listNativeAgentDirectMessages(
  sqlite: Database,
  externalAgentSessionId: string,
  peer: string,
  opts: { before?: string; after?: string; limit?: number } = {}
): NativeAgentDirectMessage[] {
  const session = getExternalAgentSession(sqlite, externalAgentSessionId);
  if (!session) return [];
  const binds: Record<string, string | number> = {
    $externalAgentSessionId: externalAgentSessionId,
    $projectId: session.transcriptTargetId,
    $self: session.agentName,
    $peer: peer
  };
  const clauses = [
    'project_id = $projectId',
    '((from_agent = $self AND peer = $peer) OR (from_agent = $peer AND peer = $self))'
  ];
  if (opts.before) {
    clauses.push('rowid < COALESCE((SELECT rowid FROM native_agent_direct_messages WHERE id = $before), 9.2e18)');
    binds.$before = opts.before;
  }
  if (opts.after) {
    clauses.push('rowid > COALESCE((SELECT rowid FROM native_agent_direct_messages WHERE id = $after), 0)');
    binds.$after = opts.after;
  }
  let query = `SELECT * FROM native_agent_direct_messages WHERE ${clauses.join(' AND ')} ORDER BY rowid ASC`;
  if (opts.limit && opts.limit > 0) {
    query += ' LIMIT $limit';
    binds.$limit = opts.limit;
  }
  const rows = sqlite.query(query).all(binds) as Array<Record<string, unknown>>;
  // One batched registry lookup for the whole page (agent read is a polled hot path — avoid a
  // per-row/per-id point query). Dangling ids (registry row deleted) are silently dropped.
  const rowIds = rows.map((row) => parseAttachmentIds(row.attachment_ids as string | null));
  const refMap = getMessageAttachmentRefs(sqlite, [...new Set(rowIds.flat())]);
  return rows.map((row, index) => {
    const attachments = (rowIds[index] ?? [])
      .map((id) => refMap.get(id))
      .filter((ref): ref is MessageAttachmentRef => ref !== undefined);
    return {
      id: row.id as NativeAgentDirectMessage['id'],
      sessionId: row.project_id as NativeAgentDirectMessage['sessionId'],
      externalAgentSessionId: row.external_agent_session_id as string,
      fromAgent: (row.from_agent as string | null) ?? null,
      peer: row.peer as string,
      text: row.text as string,
      ...(attachments.length ? { attachments } : {}),
      createdAt: row.created_at as string
    };
  });
}
