// Pure SQLite-row → domain-object mappers and the small value helpers they use. No DB handle, no
// I/O — split out of index.ts so the Store class is just query orchestration. Row shapes come from
// the drizzle schema ($inferSelect); domain shapes come from @monad/protocol.

import type { ChatMessage, MessageType, Session, SessionState, StreamStatus, WorkplaceProject } from '@monad/protocol';

import { sessionOriginSchema, transcriptTargetIdSchema } from '@monad/protocol';

import { messages, sessions, workplaceProjects } from './schema.ts';
import { parseSessionModelSelection } from './session-model-selection.ts';

export type SessionRow = typeof sessions.$inferSelect;
export type WorkplaceProjectRow = typeof workplaceProjects.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export interface SearchRow {
  id: string;
  transcript_target_id: string;
  role: string;
  text: string;
  created_at: string;
  stitle: string;
  rank?: number;
}

export interface ChannelConversation {
  channelId: string;
  conversationKey: string;
  activeSessionId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface ChannelConversationSession {
  sessionId: string;
  label?: string;
  createdAt: string;
}

export function makeSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const start = Math.max(0, i - 30);
  const end = Math.min(text.length, i + q.length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** YYYY-MM-DD in the daemon's local timezone — the ledger is bucketed by local calendar day. */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const toIntFlag = (b: boolean | undefined): number | null => (b === undefined ? null : b ? 1 : 0);

export function rowToConversation(row: Record<string, unknown>): ChannelConversation {
  return {
    channelId: row.channel_id as string,
    conversationKey: row.conversation_key as string,
    activeSessionId: row.active_session_id as string,
    createdAt: row.created_at as string,
    lastSeenAt: row.last_seen_at as string
  };
}

// Tolerate a malformed/absent origin blob: a single bad row must not throw and take down the whole
// listSessions() result. Degrade to undefined (= unrestricted) and warn, rather than crash the list.
function parseOrigin(raw: string | null): Session['origin'] {
  if (!raw) return undefined;
  try {
    const parsed = sessionOriginSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    process.stderr.write(`store: ignoring malformed session.origin (${parsed.error.issues[0]?.message})\n`);
  } catch (err) {
    process.stderr.write(`store: ignoring unparseable session.origin (${err instanceof Error ? err.message : err})\n`);
  }
  return undefined;
}

export function rowToSession(row: SessionRow): Session {
  const modelSelection = parseSessionModelSelection(row.model);
  return {
    id: row.id as Session['id'],
    projectId: (row.projectId ?? undefined) as Session['projectId'],
    title: row.title,
    state: row.state as SessionState,
    agentIds: JSON.parse(row.agentIds) as Session['agentIds'],
    archived: row.archived === 1,
    restoreCount: row.restoreCount,
    model: modelSelection.model,
    reasoningEffort: modelSelection.effort,
    cwd: row.cwd ?? undefined,
    origin: parseOrigin(row.origin),
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens
    },
    costUsd: row.costUsd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function rowToWorkplaceProject(row: WorkplaceProjectRow): WorkplaceProject {
  return {
    id: row.id as WorkplaceProject['id'],
    title: row.title,
    state: row.state as SessionState,
    archived: row.archived === 1,
    model: row.model ?? undefined,
    cwd: row.cwd ?? undefined,
    origin: parseOrigin(row.origin),
    memberTemplates: JSON.parse(row.memberTemplates) as WorkplaceProject['memberTemplates'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function rowToMessage(row: MessageRow): ChatMessage {
  const status = row.streamStatus as StreamStatus;
  const sessionId = transcriptTargetIdSchema.parse(row.transcriptTargetId);
  const messageId = row.id as ChatMessage['id'];
  const type = row.type as MessageType;
  // `source` is not persisted; reconstruct it for live rows so a client can open the message-scoped
  // generation subscription.
  const live = status === 'pending' || status === 'streaming';
  return {
    id: messageId,
    sessionId,
    role: row.role as ChatMessage['role'],
    text: row.text,
    type,
    data: row.data != null ? (JSON.parse(row.data) as unknown) : undefined,
    stream: {
      status,
      source: live ? { transcriptTargetId: sessionId, messageId } : undefined
    },
    active: row.active === 1,
    ...(row.includeInContext != null ? { includeInContext: row.includeInContext === 1 } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined
  };
}
