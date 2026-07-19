import type { Database } from 'bun:sqlite';
import type { ChatMessage, IdempotencyKey, MessageId, MessageType, TranscriptTargetId } from '@monad/protocol';

import { isDeepStrictEqual } from 'node:util';
import { chatMessageSchema } from '@monad/protocol';

import { type MessageRow, rowToMessage } from './row-mappers.ts';

export interface MessageMutationResult {
  message: ChatMessage;
  messageRevision: number;
  changed: boolean;
}

interface MutationIdentity {
  transcriptTargetId: TranscriptTargetId;
  messageId: MessageId;
  idempotencyKey: IdempotencyKey;
  fingerprint: string;
  updatedAt: string;
}

export interface CreateMessageInput {
  message: ChatMessage;
  idempotencyKey: IdempotencyKey;
  fingerprint: string;
}

export interface UpdateMessageInput extends MutationIdentity {
  updates: {
    text?: string;
    type?: MessageType;
    data?: unknown;
    includeInContext?: boolean;
    active?: boolean;
  };
}

export interface SettleMessageInput extends MutationIdentity {
  text: string;
  type?: MessageType;
  data?: unknown;
  includeInContext?: boolean;
}

export interface FailMessageInput extends MutationIdentity {
  text?: string;
  type?: MessageType;
  data?: unknown;
  includeInContext?: boolean;
}

export type RemoveMessageInput = MutationIdentity;

export interface MessageListSnapshot {
  messages: ChatMessage[];
  messageRevision: number;
}

function decodeMessageRow(row: Record<string, unknown>): ChatMessage {
  return chatMessageSchema.parse(
    JSON.parse(
      JSON.stringify(
        rowToMessage({
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
      )
    )
  );
}

function getMutationReplay(
  sqlite: Database,
  transcriptTargetId: TranscriptTargetId,
  idempotencyKey: IdempotencyKey,
  fingerprint: string
): MessageMutationResult | null {
  const row = sqlite
    .query(
      `SELECT command_fingerprint, message_revision, result_message
       FROM message_mutations
       WHERE transcript_target_id = ? AND idempotency_key = ?`
    )
    .get(transcriptTargetId, idempotencyKey) as {
    command_fingerprint: string;
    message_revision: number;
    result_message: string;
  } | null;
  if (!row) return null;
  if (row.command_fingerprint !== fingerprint) {
    throw new Error('idempotency key reused with a different command');
  }
  return {
    message: chatMessageSchema.parse(JSON.parse(row.result_message)),
    messageRevision: row.message_revision,
    changed: false
  };
}

function currentRevision(sqlite: Database, transcriptTargetId: TranscriptTargetId): number {
  const row = sqlite
    .query('SELECT revision FROM transcript_message_revisions WHERE transcript_target_id = ?')
    .get(transcriptTargetId) as { revision: number } | null;
  return row?.revision ?? 0;
}

function bumpRevision(sqlite: Database, transcriptTargetId: TranscriptTargetId): number {
  const row = sqlite
    .query(
      `INSERT INTO transcript_message_revisions (transcript_target_id, revision)
       VALUES (?, 1)
       ON CONFLICT(transcript_target_id) DO UPDATE SET revision = revision + 1
       RETURNING revision`
    )
    .get(transcriptTargetId) as { revision: number };
  return row.revision;
}

function saveMutation(
  sqlite: Database,
  input: {
    transcriptTargetId: TranscriptTargetId;
    idempotencyKey: IdempotencyKey;
    fingerprint: string;
    message: ChatMessage;
    messageRevision: number;
  }
): void {
  sqlite
    .query(
      `INSERT INTO message_mutations
       (transcript_target_id, idempotency_key, command_fingerprint, message_id, message_revision, result_message)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.transcriptTargetId,
      input.idempotencyKey,
      input.fingerprint,
      input.message.id,
      input.messageRevision,
      JSON.stringify(input.message)
    );
}

function finishMutation(
  sqlite: Database,
  input: {
    transcriptTargetId: TranscriptTargetId;
    idempotencyKey: IdempotencyKey;
    fingerprint: string;
    message: ChatMessage;
    changed: boolean;
  }
): MessageMutationResult {
  const messageRevision = input.changed
    ? bumpRevision(sqlite, input.transcriptTargetId)
    : currentRevision(sqlite, input.transcriptTargetId);
  saveMutation(sqlite, { ...input, messageRevision });
  return { message: input.message, messageRevision, changed: input.changed };
}

export function createMessage(sqlite: Database, input: CreateMessageInput): MessageMutationResult {
  return sqlite.transaction(() => {
    const replay = getMutationReplay(sqlite, input.message.sessionId, input.idempotencyKey, input.fingerprint);
    if (replay) return replay;
    const message = chatMessageSchema.parse(input.message);
    sqlite
      .query(
        `INSERT INTO messages
         (id, transcript_target_id, role, text, type, data, stream_status, active, include_in_context,
          idempotency_key, command_fingerprint, created_at, updated_at)
         VALUES ($id, $target, $role, $text, $type, $data, $status, $active, $includeInContext,
          $idempotencyKey, $fingerprint, $createdAt, $updatedAt)`
      )
      .run({
        $id: message.id,
        $target: message.sessionId,
        $role: message.role,
        $text: message.text,
        $type: message.type,
        $data: message.data === undefined ? null : JSON.stringify(message.data),
        $status: message.stream.status,
        $active: message.active ? 1 : 0,
        $includeInContext: message.includeInContext === undefined ? null : message.includeInContext ? 1 : 0,
        $idempotencyKey: input.idempotencyKey,
        $fingerprint: input.fingerprint,
        $createdAt: message.createdAt,
        $updatedAt: message.updatedAt ?? null
      });
    return finishMutation(sqlite, {
      transcriptTargetId: message.sessionId,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      message,
      changed: true
    });
  })();
}

function requireMessageRow(
  sqlite: Database,
  transcriptTargetId: TranscriptTargetId,
  messageId: MessageId
): Record<string, unknown> {
  const row = sqlite
    .query('SELECT * FROM messages WHERE transcript_target_id = ? AND id = ?')
    .get(transcriptTargetId, messageId) as Record<string, unknown> | null;
  if (!row) throw new Error(`message not found: ${messageId}`);
  return row;
}

export function updateCanonicalMessage(sqlite: Database, input: UpdateMessageInput): MessageMutationResult {
  return sqlite.transaction(() => {
    const replay = getMutationReplay(sqlite, input.transcriptTargetId, input.idempotencyKey, input.fingerprint);
    if (replay) return replay;
    const current = decodeMessageRow(requireMessageRow(sqlite, input.transcriptTargetId, input.messageId));
    const candidate = chatMessageSchema.parse({ ...current, ...input.updates });
    const changed = !isDeepStrictEqual(
      {
        text: current.text,
        type: current.type,
        data: current.data,
        includeInContext: current.includeInContext,
        active: current.active
      },
      {
        text: candidate.text,
        type: candidate.type,
        data: candidate.data,
        includeInContext: candidate.includeInContext,
        active: candidate.active
      }
    );
    const next = changed ? chatMessageSchema.parse({ ...candidate, updatedAt: input.updatedAt }) : current;
    if (changed) {
      sqlite
        .query(
          `UPDATE messages SET text = ?, type = ?, data = ?, active = ?, include_in_context = ?, updated_at = ?
           WHERE transcript_target_id = ? AND id = ?`
        )
        .run(
          next.text,
          next.type,
          next.data === undefined ? null : JSON.stringify(next.data),
          next.active ? 1 : 0,
          next.includeInContext === undefined ? null : next.includeInContext ? 1 : 0,
          next.updatedAt ?? null,
          input.transcriptTargetId,
          input.messageId
        );
    }
    return finishMutation(sqlite, { ...input, message: next, changed });
  })();
}

function finishStreamingMessage(
  sqlite: Database,
  input: SettleMessageInput | FailMessageInput,
  status: 'complete' | 'error'
): MessageMutationResult {
  return sqlite.transaction(() => {
    const replay = getMutationReplay(sqlite, input.transcriptTargetId, input.idempotencyKey, input.fingerprint);
    if (replay) return replay;
    const current = decodeMessageRow(requireMessageRow(sqlite, input.transcriptTargetId, input.messageId));
    if (current.stream.status !== 'pending' && current.stream.status !== 'streaming') {
      throw new Error(`message is already terminal: ${input.messageId}`);
    }
    const next = chatMessageSchema.parse({
      ...current,
      ...('text' in input ? { text: input.text } : {}),
      ...('type' in input ? { type: input.type } : {}),
      ...('data' in input ? { data: input.data } : {}),
      ...('includeInContext' in input ? { includeInContext: input.includeInContext } : {}),
      stream: { status },
      updatedAt: input.updatedAt
    });
    sqlite
      .query(
        `UPDATE messages SET text = ?, type = ?, data = ?, include_in_context = ?, stream_status = ?, updated_at = ?
         WHERE transcript_target_id = ? AND id = ?`
      )
      .run(
        next.text,
        next.type,
        next.data === undefined ? null : JSON.stringify(next.data),
        next.includeInContext === undefined ? null : next.includeInContext ? 1 : 0,
        status,
        input.updatedAt,
        input.transcriptTargetId,
        input.messageId
      );
    return finishMutation(sqlite, { ...input, message: next, changed: true });
  })();
}

export function settleCanonicalMessage(sqlite: Database, input: SettleMessageInput): MessageMutationResult {
  return finishStreamingMessage(sqlite, input, 'complete');
}

export function failCanonicalMessage(sqlite: Database, input: FailMessageInput): MessageMutationResult {
  return finishStreamingMessage(sqlite, input, 'error');
}

export function removeCanonicalMessage(sqlite: Database, input: RemoveMessageInput): MessageMutationResult {
  return sqlite.transaction(() => {
    const replay = getMutationReplay(sqlite, input.transcriptTargetId, input.idempotencyKey, input.fingerprint);
    if (replay) return replay;
    const current = decodeMessageRow(requireMessageRow(sqlite, input.transcriptTargetId, input.messageId));
    const next = chatMessageSchema.parse({ ...current, active: false, updatedAt: input.updatedAt });
    if (current.active) {
      sqlite
        .query('UPDATE messages SET active = 0, updated_at = ? WHERE transcript_target_id = ? AND id = ?')
        .run(input.updatedAt, input.transcriptTargetId, input.messageId);
    }
    return finishMutation(sqlite, { ...input, message: next, changed: current.active });
  })();
}

export function getMessageRevision(sqlite: Database, transcriptTargetId: TranscriptTargetId): number {
  return currentRevision(sqlite, transcriptTargetId);
}
