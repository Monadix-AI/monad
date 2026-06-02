// Native agent direct messages: peer-to-peer messages between MeshAgents within a project.
// Split out of index.ts — every function takes the raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type { MessageAttachmentRef, NativeAgentDirectMessage } from '@monad/protocol';

import { getMessageAttachmentRefs, parseAttachmentIds } from './attachments.ts';
import { getMeshSession } from './mesh-sessions.ts';

export interface NativeAgentDirectMessageRequestIdentity {
  requestId: string;
  requestFingerprint: string;
}

export interface NativeAgentDirectMessageInsertResult {
  message: NativeAgentDirectMessage;
  replayed: boolean;
}

export class NativeAgentDirectMessageIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key reused with a different command');
    this.name = 'NativeAgentDirectMessageIdempotencyConflictError';
  }
}

function decodeNativeAgentDirectMessage(sqlite: Database, row: Record<string, unknown>): NativeAgentDirectMessage {
  const attachmentIds = parseAttachmentIds(row.attachment_ids as string | null);
  const refs = getMessageAttachmentRefs(sqlite, attachmentIds);
  const attachments = attachmentIds
    .map((attachmentId) => refs.get(attachmentId))
    .filter((ref): ref is MessageAttachmentRef => ref !== undefined);
  return {
    id: row.id as NativeAgentDirectMessage['id'],
    sessionId: row.session_id as NativeAgentDirectMessage['sessionId'],
    meshSessionId: row.mesh_session_id as string,
    fromAgent: (row.from_agent as string | null) ?? null,
    peer: row.peer as string,
    text: row.text as string,
    ...(attachments.length ? { attachments } : {}),
    createdAt: row.created_at as string
  };
}

export function insertNativeAgentDirectMessage(
  sqlite: Database,
  row: NativeAgentDirectMessage,
  identity?: NativeAgentDirectMessageRequestIdentity
): NativeAgentDirectMessageInsertResult {
  try {
    sqlite
      .query(
        `INSERT INTO native_agent_direct_messages
          (id, session_id, mesh_session_id, from_agent, peer, text, attachment_ids, request_id, request_fingerprint, created_at)
         VALUES ($id, $sessionId, $meshSessionId, $fromAgent, $peer, $text, $attachmentIds, $requestId, $requestFingerprint, $createdAt)`
      )
      .run({
        $id: row.id,
        $sessionId: row.sessionId,
        $meshSessionId: row.meshSessionId,
        $fromAgent: row.fromAgent,
        $peer: row.peer,
        $text: row.text,
        $attachmentIds: row.attachments?.length ? JSON.stringify(row.attachments.map((a) => a.id)) : null,
        $requestId: identity?.requestId ?? null,
        $requestFingerprint: identity?.requestFingerprint ?? null,
        $createdAt: row.createdAt
      });
    return { message: row, replayed: false };
  } catch (error) {
    if (!identity) throw error;
    const existing = sqlite
      .query(
        `SELECT * FROM native_agent_direct_messages
         WHERE mesh_session_id = $meshSessionId AND request_id = $requestId`
      )
      .get({ $meshSessionId: row.meshSessionId, $requestId: identity.requestId }) as Record<string, unknown> | null;
    if (!existing) throw error;
    if (existing.request_fingerprint !== identity.requestFingerprint) {
      throw new NativeAgentDirectMessageIdempotencyConflictError();
    }
    return { message: decodeNativeAgentDirectMessage(sqlite, existing), replayed: true };
  }
}

export function getNativeAgentDirectMessage(sqlite: Database, id: string): NativeAgentDirectMessage | null {
  const row = sqlite.query('SELECT * FROM native_agent_direct_messages WHERE id = ?').get(id) as Record<
    string,
    unknown
  > | null;
  if (!row) return null;
  return decodeNativeAgentDirectMessage(sqlite, row);
}

export function listNativeAgentDirectMessages(
  sqlite: Database,
  meshSessionId: string,
  peer: string,
  opts: { before?: string; after?: string; limit?: number } = {}
): NativeAgentDirectMessage[] {
  const session = getMeshSession(sqlite, meshSessionId);
  if (!session) return [];
  // The conversation is keyed by canonical projectMemberId on both sides. A runtime with no canonical owner
  // (unreconciled/foreign) resolves no self identity, so return no history rather than matching on an alias.
  if (!session.projectMemberId) return [];
  const binds: Record<string, string | number> = {
    $meshSessionId: meshSessionId,
    $sessionId: session.transcriptTargetId,
    $self: session.projectMemberId,
    $peer: peer
  };
  const clauses = [
    'session_id = $sessionId',
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
      sessionId: row.session_id as NativeAgentDirectMessage['sessionId'],
      meshSessionId: row.mesh_session_id as string,
      fromAgent: (row.from_agent as string | null) ?? null,
      peer: row.peer as string,
      text: row.text as string,
      ...(attachments.length ? { attachments } : {}),
      createdAt: row.created_at as string
    };
  });
}
