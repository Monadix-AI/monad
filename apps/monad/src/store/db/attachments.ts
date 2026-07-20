// Message attachment registry: the ref fields plus registry-only metadata. Split out of index.ts —
// content stays in the file, only the reference + a metadata snapshot is stored, and registration
// gates the wall preview/download endpoint. Every function takes the raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';
import type { MessageAttachmentRef } from '@monad/protocol';

/** Insert shape for the attachment registry — the ref fields plus registry-only metadata. */
export interface MessageAttachmentInsert {
  id: string;
  sessionId: string;
  path: string;
  name: string;
  mime: string;
  bytes: number;
  preview: string;
  createdBy?: string | null;
  createdAt: string;
}

/** Single projection from any attachment record shape to the wire ref — every ref the store hands
 *  out flows through here so the field set can't drift between code paths. */
function toAttachmentRef(att: {
  id: string;
  path: string;
  name: string;
  mime: string;
  bytes: number;
  createdAt: string;
}): MessageAttachmentRef {
  return {
    id: att.id as MessageAttachmentRef['id'],
    path: att.path,
    name: att.name,
    mime: att.mime,
    bytes: att.bytes,
    createdAt: att.createdAt
  };
}

/** Parse an attachment_ids JSON column (string[] or NULL); malformed values read as empty. */
export function parseAttachmentIds(idsJson: string | null): string[] {
  if (!idsJson) return [];
  try {
    const ids = JSON.parse(idsJson);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Register a message's file reference. Only the reference + a metadata snapshot is stored;
 *  content stays in the file. Registration also gates the wall preview/download endpoint. */
export function registerMessageAttachment(sqlite: Database, att: MessageAttachmentInsert): MessageAttachmentRef {
  sqlite
    .query(
      `INSERT INTO message_attachments
        (id, session_id, path, name, mime, bytes, preview, created_by, created_at)
       VALUES ($id, $sessionId, $path, $name, $mime, $bytes, $preview, $createdBy, $createdAt)`
    )
    .run({
      $id: att.id,
      $sessionId: att.sessionId,
      $path: att.path,
      $name: att.name,
      $mime: att.mime,
      $bytes: att.bytes,
      $preview: att.preview,
      $createdBy: att.createdBy ?? null,
      $createdAt: att.createdAt
    });
  return toAttachmentRef(att);
}

/** Register a message's file references atomically: either all rows land or none. */
export function registerMessageAttachments(
  sqlite: Database,
  atts: readonly MessageAttachmentInsert[]
): MessageAttachmentRef[] {
  if (atts.length === 0) return [];
  return sqlite.transaction(() => atts.map((att) => registerMessageAttachment(sqlite, att)))();
}

/** Roll back registrations whose message never landed (keeps the "registered = referenced by a
 *  message" gate on the client-facing read endpoint honest). */
export function deleteMessageAttachments(sqlite: Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  sqlite
    .query(`DELETE FROM message_attachments WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(...(ids as string[]));
}

export type MessageAttachmentDetail = MessageAttachmentRef & {
  sessionId: string;
  preview: string;
  createdBy: string | null;
};

export function getMessageAttachment(sqlite: Database, id: string): MessageAttachmentDetail | null {
  const row = sqlite.query('SELECT * FROM message_attachments WHERE id = ?').get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    ...toAttachmentRef({
      id: row.id as string,
      path: row.path as string,
      name: row.name as string,
      mime: row.mime as string,
      bytes: row.bytes as number,
      createdAt: row.created_at as string
    }),
    sessionId: row.session_id as string,
    preview: row.preview as string,
    createdBy: (row.created_by as string | null) ?? null
  };
}

/** Batch-hydrate refs for a set of ids in one query (column-projected — no preview blobs).
 *  Missing ids are simply absent from the map. */
export function getMessageAttachmentRefs(sqlite: Database, ids: readonly string[]): Map<string, MessageAttachmentRef> {
  const refs = new Map<string, MessageAttachmentRef>();
  if (ids.length === 0) return refs;
  const rows = sqlite
    .query(
      `SELECT id, path, name, mime, bytes, created_at AS createdAt
       FROM message_attachments WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...(ids as string[])) as Array<{
    id: string;
    path: string;
    name: string;
    mime: string;
    bytes: number;
    createdAt: string;
  }>;
  for (const row of rows) refs.set(row.id, toAttachmentRef(row));
  return refs;
}
