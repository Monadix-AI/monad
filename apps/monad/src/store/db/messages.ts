// Message CRUD, generative-message lifecycle, history windows/lineage, per-session durable KV, and
// restore. Split out of index.ts. Functions take the raw bun:sqlite handle (`sqlite`) and, where a
// schema-typed insert or lineage walk is needed, the drizzle handle (`db`).

import type { Database } from 'bun:sqlite';
import type { ChatMessage, MessageId, MessageType, Session, SessionId, StreamStatus } from '@monad/protocol';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { persistedIncludeInContext } from '@monad/protocol';

import { type MessageRow, rowToMessage, toIntFlag } from './row-mappers.ts';
import { messages } from './schema.ts';
import { getSession, provenance } from './sessions.ts';

type Db = BunSQLiteDatabase<Record<string, never>>;

export interface ListMessagesOptions {
  limit?: number;
  /** Restrict to a project thread: the root message id plus replies carrying data.threadId. */
  threadId?: string;
  /** Exclusive cursor — return messages strictly before this message id (by rowid). */
  before?: string;
  /** Exclusive cursor — return messages strictly after this message id (by rowid). */
  after?: string;
  /** Include rewound (active=0) rows. Defaults to false. */
  includeInactive?: boolean;
  /** Take the NEWEST `limit` rows instead of the oldest, but still return them oldest→newest.
      Combine with `before` to page a newest-first window backward. For history pagination. */
  latest?: boolean;
  /** Return a `limit`-sized window centred on (and INCLUDING) this message id — for deep-linking
      to a message in the middle of history. Overrides before/after/latest. */
  around?: string;
}

export function insertMessage(
  db: Db,
  id: string,
  transcriptTargetId: string,
  text: string,
  createdAt: string,
  role: ChatMessage['role'] = 'user',
  opts: { type?: MessageType; data?: unknown; streamStatus?: StreamStatus; includeInContext?: boolean } = {}
): void {
  db.insert(messages)
    .values({
      id,
      transcriptTargetId,
      role,
      text,
      type: opts.type ?? 'text',
      data: opts.data !== undefined ? JSON.stringify(opts.data) : null,
      streamStatus: opts.streamStatus ?? 'settled',
      includeInContext: toIntFlag(persistedIncludeInContext(opts.type ?? 'text', opts.includeInContext)),
      createdAt
    })
    .run();
}

export function messageSeq(sqlite: Database, transcriptTargetId: string, messageId: string): number {
  const row = sqlite
    .query('SELECT rowid AS seq FROM messages WHERE id = ? AND transcript_target_id = ?')
    .get(messageId, transcriptTargetId) as { seq: number } | null;
  return row?.seq ?? 0;
}

/** Advance a generative message's lifecycle, rejecting illegal/backward transitions
 * (anything leaving a terminal `complete`/`error`). Optionally set the final `text`/`data` in the
 * same write (so a `complete` transition lands the settled content atomically). Returns false if
 * the row is missing or the transition is disallowed. */
export function setGenStatus(
  sqlite: Database,
  transcriptTargetId: string,
  messageId: string,
  next: StreamStatus,
  updatedAt: string,
  content?: { text?: string; data?: unknown; type?: MessageType; includeInContext?: boolean; createdAt?: string }
): boolean {
  const row = sqlite
    .query('SELECT stream_status FROM messages WHERE id = ? AND transcript_target_id = ?')
    .get(messageId, transcriptTargetId) as { stream_status: string } | null;
  if (!row) return false;
  const cur = row.stream_status as StreamStatus;
  if (cur === 'complete' || cur === 'error') return false;
  const allowed: Record<StreamStatus, StreamStatus[]> = {
    settled: [],
    pending: ['streaming', 'complete', 'error'],
    streaming: ['complete', 'error'],
    complete: [],
    error: []
  };
  if (!allowed[cur].includes(next)) return false;
  const sets = ['stream_status = $status', 'updated_at = $updatedAt'];
  const binds: Record<string, string | number | null> = {
    $status: next,
    $updatedAt: updatedAt,
    $id: messageId,
    $target: transcriptTargetId
  };
  if (content?.text !== undefined) {
    sets.push('text = $text');
    binds.$text = content.text;
  }
  if (content && 'data' in content) {
    sets.push('data = $data');
    binds.$data = content.data !== undefined ? JSON.stringify(content.data) : null;
  }
  if (content?.type !== undefined) {
    sets.push('type = $type');
    binds.$type = content.type;
  }
  if (content?.includeInContext !== undefined) {
    sets.push('include_in_context = $includeInContext');
    binds.$includeInContext = content.includeInContext ? 1 : 0;
  }
  // A streaming message's row is inserted when its placeholder is reserved (e.g. a managed native
  // CLI "thinking" wake, stamped at fan-out time). The wall orders by created_at, so leaving it at
  // reserve time makes replies sort by when the agent was woken, not when it actually posted —
  // re-stamping on completion aligns the durable order with post order.
  if (content?.createdAt !== undefined) {
    sets.push('created_at = $createdAt');
    binds.$createdAt = content.createdAt;
  }
  sqlite.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id AND transcript_target_id = $target`).run(binds);
  return true;
}

/** On daemon startup, terminally fail any rows left mid-stream by a crash/restart. Their turn is
 * dead and can never resume, so a client that sees `pending`/`streaming` would subscribe to a gone
 * stream and hang. Flipping them to `error` makes clients render from the row (terminal) instead;
 * excluding them from context keeps a half/empty turn out of later prompts. Returns the row count.
 * Safe because a freshly-started daemon has no live turns — every in-flight row is orphaned. */
export function failOrphanedStreamingMessages(sqlite: Database, updatedAt: string): number {
  // Count via SELECT, not the UPDATE's `.changes`: the messages FTS triggers inflate the reported
  // change count, so it can't be trusted as a row count here.
  const n = (
    sqlite.query("SELECT COUNT(*) AS c FROM messages WHERE stream_status IN ('pending', 'streaming')").get() as {
      c: number;
    }
  ).c;
  if (n > 0) {
    sqlite
      .query(
        `UPDATE messages
         SET active = 0, stream_status = 'complete', include_in_context = 0, updated_at = $at
         WHERE stream_status IN ('pending', 'streaming')
           AND role = 'assistant'
           AND text = ''
           AND json_extract(data, '$.source') = 'managed-external-agent'`
      )
      .run({ $at: updatedAt });
    sqlite
      .query(
        "UPDATE messages SET stream_status = 'error', include_in_context = 0, updated_at = $at WHERE stream_status IN ('pending', 'streaming')"
      )
      .run({ $at: updatedAt });
  }
  return n;
}

/** Ordered by sqlite rowid (insertion order). Defaults to active (non-rewound) messages only. */
export function listMessages(
  sqlite: Database,
  transcriptTargetId: string,
  opts: ListMessagesOptions = {}
): ChatMessage[] {
  const binds: Record<string, string | number> = { $target: transcriptTargetId };
  const active = opts.includeInactive ? '' : ' AND active = 1';
  const thread = opts.threadId ? " AND (id = $threadId OR json_extract(data, '$.threadId') = $threadId)" : '';
  if (opts.threadId) binds.$threadId = opts.threadId;
  let q: string;
  let reverse = false;
  if (opts.around) {
    // Inclusive window centred on the anchor: `half`+1 rows at-or-older + `half` newer, ASC.
    const half = Math.max(1, Math.floor((opts.limit ?? 50) / 2));
    binds.$around = opts.around;
    binds.$upper = half + 1;
    binds.$lower = half;
    // `_rid` is aliased out because a UNION's outer ORDER BY can only reference output columns.
    q =
      `SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE transcript_target_id = $target${active}${thread}` +
      ' AND rowid <= COALESCE((SELECT rowid FROM messages WHERE id = $around), 9.2e18)' +
      ' ORDER BY rowid DESC LIMIT $upper)' +
      ` UNION ALL SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE transcript_target_id = $target${active}${thread}` +
      ' AND rowid > COALESCE((SELECT rowid FROM messages WHERE id = $around), 9.2e18)' +
      ' ORDER BY rowid ASC LIMIT $lower)' +
      ' ORDER BY _rid ASC';
  } else {
    const clauses = ['transcript_target_id = $target'];
    if (!opts.includeInactive) clauses.push('active = 1');
    if (opts.threadId) clauses.push("(id = $threadId OR json_extract(data, '$.threadId') = $threadId)");
    if (opts.before) {
      clauses.push('rowid < COALESCE((SELECT rowid FROM messages WHERE id = $before), 9.2e18)');
      binds.$before = opts.before;
    }
    if (opts.after) {
      // 0 floor: an unknown cursor returns everything (matches `before`'s open-ended default).
      clauses.push('rowid > COALESCE((SELECT rowid FROM messages WHERE id = $after), 0)');
      binds.$after = opts.after;
    }
    // `latest` takes the newest `limit` (rowid DESC) then flips back to chronological order,
    // so callers always receive oldest→newest regardless of which end the window came from.
    const order = opts.latest ? 'DESC' : 'ASC';
    q = `SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY rowid ${order}`;
    if (opts.limit && opts.limit > 0) {
      q += ' LIMIT $limit';
      binds.$limit = opts.limit;
    }
    reverse = Boolean(opts.latest);
  }
  const rows = sqlite.query(q).all(binds) as Array<Record<string, unknown>>;
  if (reverse) rows.reverse();
  return rows.map((r) =>
    rowToMessage({
      id: r.id as string,
      transcriptTargetId: r.transcript_target_id as string,
      role: r.role as string,
      text: r.text as string,
      type: r.type as string,
      data: (r.data ?? null) as string | null,
      streamStatus: r.stream_status as string,
      active: r.active as number,
      includeInContext: (r.include_in_context ?? null) as number | null,
      createdAt: r.created_at as string,
      updatedAt: (r.updated_at ?? null) as string | null
    } as MessageRow)
  );
}

/**
 * Full history for a session INCLUDING inherited ancestor messages, root-first, with each
 * ancestor truncated at the branch point its child forked from. For a root (non-branched)
 * session this is exactly `listMessages`. The agent loop uses this so a branched session sees
 * its parent context, and the `sessions.messages` includeAncestors view shares the same logic.
 */
export function listMessagesWithLineage(
  sqlite: Database,
  db: Db,
  sessionId: string,
  opts: { includeInactive?: boolean; after?: string } = {}
): ChatMessage[] {
  const self = getSession(db, sessionId);
  // `after` operates on the assembled lineage list (an id may live in an ancestor), so for a
  // root session we still slice here rather than delegating the cursor to listMessages.
  const sliceAfter = (msgs: ChatMessage[]): ChatMessage[] => {
    if (!opts.after) return msgs;
    const i = msgs.findIndex((m) => m.id === opts.after);
    return i === -1 ? msgs : msgs.slice(i + 1); // unknown cursor → everything (matches listMessages)
  };
  if (!self?.parentSessionId)
    return sliceAfter(listMessages(sqlite, sessionId, { includeInactive: opts.includeInactive }));

  const chain = [...provenance(sqlite, db, sessionId).ancestors, self];
  const out: ChatMessage[] = [];
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i] as Session;
    const child = chain[i + 1];
    let segment = listMessages(sqlite, node.id, { includeInactive: opts.includeInactive });
    if (child?.branchedAtMessageId) {
      const cut = segment.findIndex((m) => m.id === child.branchedAtMessageId);
      if (cut >= 0) segment = segment.slice(0, cut + 1);
    }
    for (const m of segment) out.push(m);
  }
  // Slice the FULL lineage list — the boundary id may be in an ancestor segment, which a
  // per-session `after` query would miss (dropping post-boundary ancestor messages).
  return sliceAfter(out);
}

export function getMessage(sqlite: Database, transcriptTargetId: string, messageId: string): ChatMessage | null {
  const row = sqlite
    .query('SELECT * FROM messages WHERE id = ? AND transcript_target_id = ?')
    .get(messageId, transcriptTargetId) as Record<string, unknown> | null;
  if (!row) return null;
  return rowToMessage({
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
}

export function findManagedExternalAgentStreamingMessage(
  sqlite: Database,
  transcriptTargetId: string,
  externalAgentSessionId: string,
  agentName: string
): string | null {
  const row = sqlite
    .query(
      `SELECT id FROM messages
       WHERE transcript_target_id = $target
         AND role = 'assistant'
         AND active = 1
         AND stream_status IN ('pending', 'streaming')
         AND json_extract(data, '$.source') = 'managed-external-agent'
         AND json_extract(data, '$.externalAgentSessionId') = $externalAgentSessionId
         AND json_extract(data, '$.agentName') = $agentName
       ORDER BY rowid DESC
       LIMIT 1`
    )
    .get({ $target: transcriptTargetId, $externalAgentSessionId: externalAgentSessionId, $agentName: agentName }) as {
    id: string;
  } | null;
  return row?.id ?? null;
}

export function retireManagedExternalAgentStreamingMessage(
  sqlite: Database,
  transcriptTargetId: string,
  messageId: string,
  externalAgentSessionId: string,
  agentName: string,
  updatedAt = new Date().toISOString()
): boolean {
  const result = sqlite
    .query(
      `UPDATE messages
       SET active = 0, stream_status = 'complete', updated_at = $updatedAt
       WHERE id = $id
         AND transcript_target_id = $target
         AND role = 'assistant'
         AND active = 1
         AND stream_status IN ('pending', 'streaming')
         AND json_extract(data, '$.source') = 'managed-external-agent'
         AND json_extract(data, '$.externalAgentSessionId') = $externalAgentSessionId
         AND json_extract(data, '$.agentName') = $agentName`
    )
    .run({
      $updatedAt: updatedAt,
      $id: messageId,
      $target: transcriptTargetId,
      $externalAgentSessionId: externalAgentSessionId,
      $agentName: agentName
    });
  return result.changes === 1;
}

/** Global lookup of a LIVE message's text by id (no session needed). Used to trace a graph edge
 *  back to the source message it was extracted from (the bottom of the "why do you believe X"
 *  chain) — `active = 1` so a soft-deleted message can't resurface before the next reconcile. */
export function getMessageText(sqlite: Database, messageId: string): string | null {
  const row = sqlite.query('SELECT text FROM messages WHERE id = ? AND active = 1').get(messageId) as {
    text: string;
  } | null;
  return row?.text ?? null;
}

/** Per-session durable key/value (the `memory` table). Returns null when unset. */
export function getMemory(sqlite: Database, sessionId: string, key: string): string | null {
  const row = sqlite.query('SELECT value FROM memory WHERE session_id = ? AND key = ?').get(sessionId, key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

/** Upsert a per-session durable key/value. */
export function setMemory(sqlite: Database, sessionId: string, key: string, value: string): void {
  sqlite
    .query(
      'INSERT INTO memory (session_id, key, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value'
    )
    .run(sessionId, key, value);
}

/**
 * Soft-delete (active=0) `toMessageId` and everything after it, bumps restore_count.
 * Caller must validate that `toMessageId` exists and is a user message.
 */
export function restoreMessages(
  sqlite: Database,
  sessionId: string,
  toMessageId: string
): { restoredCount: number; newHeadMessageId: string | null } {
  const at = new Date().toISOString();
  // `.changes` is inflated by the FTS sync triggers on UPDATE, so count explicitly.
  const tx = sqlite.transaction(() => {
    const summaryRow = sqlite
      .query("SELECT value FROM memory WHERE session_id = $sid AND key = 'ctx:summary'")
      .get({ $sid: sessionId }) as { value: string } | null;
    let summaryBoundaryId: string | undefined;
    if (summaryRow) {
      try {
        const parsed = JSON.parse(summaryRow.value) as { uptoMessageId?: unknown };
        if (typeof parsed.uptoMessageId === 'string') summaryBoundaryId = parsed.uptoMessageId;
      } catch {
        summaryBoundaryId = undefined;
      }
    }
    const { n } = sqlite
      .query(
        `SELECT COUNT(*) AS n FROM messages
         WHERE transcript_target_id = $sid AND active = 1
           AND rowid >= (SELECT rowid FROM messages WHERE id = $mid)`
      )
      .get({ $sid: sessionId, $mid: toMessageId }) as { n: number };
    sqlite
      .query(
        `UPDATE messages SET active = 0, updated_at = $at
         WHERE transcript_target_id = $sid AND active = 1
           AND rowid >= (SELECT rowid FROM messages WHERE id = $mid)`
      )
      .run({ $at: at, $sid: sessionId, $mid: toMessageId });
    if (summaryBoundaryId) {
      const invalidated = sqlite
        .query(
          `SELECT 1 AS invalidated
           FROM messages target
           JOIN messages boundary ON boundary.id = $boundary
           WHERE target.id = $mid
             AND target.transcript_target_id = $sid
             AND boundary.transcript_target_id = $sid
             AND target.rowid <= boundary.rowid
           LIMIT 1`
        )
        .get({ $sid: sessionId, $mid: toMessageId, $boundary: summaryBoundaryId }) as {
        invalidated: number;
      } | null;
      if (invalidated) {
        sqlite.query("DELETE FROM memory WHERE session_id = $sid AND key = 'ctx:summary'").run({
          $sid: sessionId
        });
      }
    }
    sqlite
      .query('UPDATE sessions SET restore_count = restore_count + 1, updated_at = $at WHERE id = $id')
      .run({ $at: at, $id: sessionId });
    return n;
  });
  const restoredCount = tx();
  const head = sqlite
    .query('SELECT id FROM messages WHERE transcript_target_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1')
    .get(sessionId) as { id: string } | null;
  return { restoredCount, newHeadMessageId: head?.id ?? null };
}

export function maxMessageSeq(sqlite: Database, sessionId: string): number {
  const row = sqlite
    .query('SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages WHERE transcript_target_id = ?')
    .get(sessionId) as { seq: number } | null;
  return row?.seq ?? 0;
}

export function maxMessageCreatedAt(sqlite: Database, sessionId: string): string | null {
  const row = sqlite
    .query('SELECT MAX(created_at) AS created_at FROM messages WHERE transcript_target_id = ?')
    .get(sessionId) as { created_at: string | null } | null;
  return row?.created_at ?? null;
}

export function messageIdForSeq(sqlite: Database, transcriptTargetId: SessionId, seq: number): MessageId | null {
  const row = sqlite
    .query('SELECT id FROM messages WHERE transcript_target_id = ? AND rowid = ?')
    .get(transcriptTargetId, seq) as { id: MessageId } | null;
  return row?.id ?? null;
}
