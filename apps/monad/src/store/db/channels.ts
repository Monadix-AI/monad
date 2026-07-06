// Channel conversations (per-conversation active-session index). Split out of index.ts — every
// function takes the raw bun:sqlite handle.

import type { Database } from 'bun:sqlite';

import { type ChannelConversation, type ChannelConversationSession, rowToConversation } from './row-mappers.ts';

export function getActiveConversation(
  sqlite: Database,
  channelId: string,
  conversationKey: string
): ChannelConversation | null {
  const row = sqlite
    .query('SELECT * FROM channel_conversations WHERE channel_id = ? AND conversation_key = ?')
    .get(channelId, conversationKey) as Record<string, unknown> | null;
  return row ? rowToConversation(row) : null;
}

/** Repoint a conversation at `sessionId`, recording it in the history index. Upsert. */
export function setActiveSession(
  sqlite: Database,
  args: {
    channelId: string;
    conversationKey: string;
    sessionId: string;
    principalId: string;
    label?: string;
  }
): void {
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite
      .query(
        `INSERT INTO channel_conversations
           (channel_id, conversation_key, active_session_id, principal_id, created_at, last_seen_at)
         VALUES ($channelId, $key, $sessionId, $principalId, $now, $now)
         ON CONFLICT(channel_id, conversation_key)
         DO UPDATE SET active_session_id = $sessionId, principal_id = $principalId, last_seen_at = $now`
      )
      .run({
        $channelId: args.channelId,
        $key: args.conversationKey,
        $sessionId: args.sessionId,
        $principalId: args.principalId,
        $now: now
      });
    sqlite
      .query(
        `INSERT OR IGNORE INTO channel_conversation_sessions
           (channel_id, conversation_key, session_id, label, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(args.channelId, args.conversationKey, args.sessionId, args.label ?? null, now);
  });
  tx();
}

export function touchConversation(sqlite: Database, channelId: string, conversationKey: string): void {
  sqlite
    .query('UPDATE channel_conversations SET last_seen_at = ? WHERE channel_id = ? AND conversation_key = ?')
    .run(new Date().toISOString(), channelId, conversationKey);
}

export function listConversationSessions(
  sqlite: Database,
  channelId: string,
  conversationKey: string
): ChannelConversationSession[] {
  const rows = sqlite
    .query(
      `SELECT session_id, label, created_at FROM channel_conversation_sessions
       WHERE channel_id = ? AND conversation_key = ? ORDER BY created_at ASC`
    )
    .all(channelId, conversationKey) as Array<{ session_id: string; label: string | null; created_at: string }>;
  return rows.map((r) => ({ sessionId: r.session_id, label: r.label ?? undefined, createdAt: r.created_at }));
}

export function countActiveConversations(sqlite: Database, channelId: string): number {
  const row = sqlite.query('SELECT COUNT(*) AS n FROM channel_conversations WHERE channel_id = ?').get(channelId) as {
    n: number;
  };
  return row.n;
}

export function listActiveConversations(
  sqlite: Database,
  channelId: string
): Array<{ conversationKey: string; activeSessionId: string }> {
  const rows = sqlite
    .query('SELECT conversation_key, active_session_id FROM channel_conversations WHERE channel_id = ?')
    .all(channelId) as Array<{ conversation_key: string; active_session_id: string }>;
  return rows.map((r) => ({ conversationKey: r.conversation_key, activeSessionId: r.active_session_id }));
}
