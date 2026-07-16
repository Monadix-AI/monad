import type {
  ChatMessage,
  Event,
  ExternalAgentInboxItem,
  GetStatsResponse,
  InboxItem,
  LedgerCategory,
  MessageAttachmentRef,
  MessageId,
  MessageType,
  NativeAgentDelivery,
  NativeAgentDeliveryId,
  NativeAgentDirectMessage,
  SearchHit,
  Session,
  SessionId,
  StatsRange,
  StreamStatus,
  Task,
  TaskState,
  TokenUsage,
  WorkplaceProject
} from '@monad/protocol';
import type { ChannelConversation, ChannelConversationSession } from './row-mappers.ts';

import { Database } from 'bun:sqlite';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';

import {
  type AcpDelegateRow,
  closeAcpDelegate,
  listAcpDelegatesForSession,
  listLiveAcpDelegates,
  pruneOldAcpDelegates,
  reconcileOrphanedDelegates,
  touchAcpDelegate,
  upsertAcpDelegate
} from './acp-delegates.ts';
import {
  deleteMessageAttachments,
  getMessageAttachment,
  getMessageAttachmentRefs,
  type MessageAttachmentDetail,
  type MessageAttachmentInsert,
  registerMessageAttachment,
  registerMessageAttachments
} from './attachments.ts';
import {
  countActiveConversations,
  getActiveConversation,
  listActiveConversations,
  listConversationSessions,
  type SetActiveSessionArgs,
  setActiveSession,
  touchConversation
} from './channels.ts';
import { type CheckpointHandle, startWalCheckpoint, stopWalCheckpoint } from './checkpoint.ts';
import { configureSqliteConnection } from './connection.ts';
import { appendEvents, type DanglingInterrupt, findDanglingInterrupts, hasEvent, listEvents } from './events.ts';
import {
  compareAndSwapExperienceState,
  type ExperienceStateEventRecord,
  type ExperienceStateRecord,
  getExperienceState,
  listExperienceState,
  listExperienceStateEvents
} from './experience-state.ts';
import {
  cancelExperienceWorkerWakeup,
  type ExperienceWorkerWakeupRecord,
  listDueExperienceWorkerWakeups,
  scheduleExperienceWorkerWakeup
} from './experience-worker-wakeups.ts';
import {
  countExternalAgentInbox,
  type EnqueueExternalAgentInboxOptions,
  enqueueExternalAgentInboxItem,
  getNativeAgentDelivery,
  hasUnconsumedExternalAgentInbox,
  listExternalAgentInbox,
  listMentionInbox,
  markExternalAgentInboxConsumed,
  markExternalAgentInboxDelivered,
  markExternalAgentInboxVisible
} from './external-agent-inbox.ts';
import {
  appendExternalAgentOutput,
  clearExternalAgentSessionRef,
  closeExternalAgentSession,
  type ExternalAgentSessionRow,
  getExternalAgentSession,
  listExternalAgentSessions,
  listExternalAgentSessionsForTranscriptTarget,
  listLiveExternalAgentSessions,
  pruneExitedExternalAgentSessions,
  reconcileOrphanedExternalAgentSessions,
  setExternalAgentDeliveredCursor,
  setExternalAgentOutputSnapshot,
  setExternalAgentVisibleCursor,
  updateExternalAgentSessionRef,
  upsertExternalAgentSession
} from './external-agent-sessions.ts';
import {
  clearFileObservations,
  type FileObservationRow,
  getFileObservation,
  recordFileObservation
} from './file-observations.ts';
import {
  cloneMessages,
  failOrphanedStreamingMessages,
  findManagedExternalAgentStreamingMessage,
  getMemory,
  getMessage,
  getMessageText,
  insertMessage,
  type ListMessagesOptions,
  listMessages,
  maxMessageCreatedAt,
  maxMessageSeq,
  messageIdForSeq,
  messageSeq,
  restoreMessages,
  retireManagedExternalAgentStreamingMessage,
  setGenStatus,
  setMemory
} from './messages.ts';
import { hasCurrentMigration, migrate } from './migrations.ts';
import { insertNativeAgentDirectMessage, listNativeAgentDirectMessages } from './native-agent-messages.ts';
import {
  clearEmbeddings,
  messagesMissingEmbedding,
  pendingEmbeddingCount,
  type SearchOptions,
  type SearchSemanticOptions,
  searchMessages,
  searchSemantic,
  staleEmbeddingCount,
  upsertEmbedding
} from './search.ts';
import {
  deleteSessionMember,
  deleteSessionMembers,
  getSessionMember,
  insertSessionMember,
  listSessionMembers,
  type SessionMember,
  type SessionMemberInsert,
  type SessionMemberPatch,
  updateSessionMember
} from './session-members.ts';
import {
  addUsage,
  clearMessages,
  countSessions,
  countWorkplaceProjects,
  deleteSession,
  deleteWorkplaceProject,
  getSession,
  getWorkplaceProject,
  insertSession,
  insertWorkplaceProject,
  type ListSessionsFilter,
  listSessions,
  listWorkplaceProjects,
  type SessionPatch,
  updateSession,
  updateWorkplaceProject,
  type WorkplaceProjectPatch
} from './sessions.ts';
import {
  clearLedger,
  computeStats,
  type LedgerBreakdownRow,
  type LedgerEntry,
  ledger,
  ledgerBreakdown,
  recordLedger
} from './stats.ts';
import { casTaskState, insertTask } from './tasks.ts';

export type { ChatMessage } from '@monad/protocol';
export type { AcpDelegateRow } from './acp-delegates.ts';
export type { ExperienceStateEventRecord, ExperienceStateRecord } from './experience-state.ts';
export type { ExperienceWorkerWakeupRecord } from './experience-worker-wakeups.ts';
export type { EnqueueExternalAgentInboxOptions } from './external-agent-inbox.ts';
export type { ExternalAgentSessionRow } from './external-agent-sessions.ts';
export type { FileObservationRow } from './file-observations.ts';
export type { ListMessagesOptions } from './messages.ts';
export type { ChannelConversation, ChannelConversationSession } from './row-mappers.ts';
export type { SearchOptions } from './search.ts';
export type { SessionMember, SessionMemberInsert, SessionMemberPatch } from './session-members.ts';
export type { ListSessionsFilter } from './sessions.ts';
export type { LedgerBreakdownRow, LedgerEntry } from './stats.ts';

export interface StoreOptions {
  /** File path, or ":memory:" for an ephemeral in-process DB (the default). */
  path?: string;
}

export class Store {
  private readonly sqlite: Database;
  readonly db: BunSQLiteDatabase<Record<string, never>>;
  #checkpoint: CheckpointHandle | undefined;

  constructor(opts: StoreOptions = {}) {
    const path = opts.path ?? ':memory:';
    const sqlite = new Database(path);
    let db: BunSQLiteDatabase<Record<string, never>>;
    try {
      configureSqliteConnection(sqlite, path);
      db = drizzle(sqlite);
      migrate(db);
    } catch (error) {
      sqlite.close();
      throw error;
    }
    this.sqlite = sqlite;
    this.db = db;
    if (opts.path && opts.path !== ':memory:') {
      this.#checkpoint = startWalCheckpoint(opts.path);
    }
  }

  hasCurrentMigration(): boolean {
    return hasCurrentMigration(this.sqlite);
  }

  getExperienceState(atomPackId: string, projectId: string, key: string): ExperienceStateRecord | null {
    return getExperienceState(this.sqlite, atomPackId, projectId, key);
  }

  listExperienceState(atomPackId: string, projectId: string, prefix: string): ExperienceStateRecord[] {
    return listExperienceState(this.sqlite, atomPackId, projectId, prefix);
  }

  compareAndSwapExperienceState(input: Parameters<typeof compareAndSwapExperienceState>[1]): boolean {
    return compareAndSwapExperienceState(this.sqlite, input);
  }

  listExperienceStateEvents(atomPackId: string, projectId: string, key: string): ExperienceStateEventRecord[] {
    return listExperienceStateEvents(this.sqlite, atomPackId, projectId, key);
  }

  scheduleExperienceWorkerWakeup(input: Omit<ExperienceWorkerWakeupRecord, 'attempt'>): void {
    scheduleExperienceWorkerWakeup(this.sqlite, input);
  }

  cancelExperienceWorkerWakeup(atomPackId: string, experienceId: string, projectId: string, key: string): void {
    cancelExperienceWorkerWakeup(this.sqlite, atomPackId, experienceId, projectId, key);
  }

  listDueExperienceWorkerWakeups(now: string): ExperienceWorkerWakeupRecord[] {
    return listDueExperienceWorkerWakeups(this.sqlite, now);
  }

  insertSession(s: Session): void {
    insertSession(this.db, s);
  }

  listSessions(filter: ListSessionsFilter = {}): Session[] {
    return listSessions(this.db, filter);
  }

  countSessions(filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
    return countSessions(this.db, filter);
  }

  getSession(id: string): Session | null {
    return getSession(this.db, id);
  }

  /** Bumps updatedAt. Returns the updated row, or null if not found. */
  updateSession(id: string, patch: SessionPatch): Session | null {
    return updateSession(this.db, id, patch);
  }

  deleteSession(id: string): boolean {
    return deleteSession(this.sqlite, id);
  }

  insertWorkplaceProject(project: WorkplaceProject): void {
    insertWorkplaceProject(this.db, project);
  }

  listWorkplaceProjects(filter: ListSessionsFilter = {}): WorkplaceProject[] {
    return listWorkplaceProjects(this.db, filter);
  }

  countWorkplaceProjects(filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
    return countWorkplaceProjects(this.db, filter);
  }

  getWorkplaceProject(id: string): WorkplaceProject | null {
    return getWorkplaceProject(this.db, id);
  }

  updateWorkplaceProject(id: string, patch: WorkplaceProjectPatch): WorkplaceProject | null {
    return updateWorkplaceProject(this.db, id, patch);
  }

  insertSessionMember(member: SessionMemberInsert): void {
    insertSessionMember(this.db, member);
  }

  listSessionMembers(sessionId: string): SessionMember[] {
    return listSessionMembers(this.db, sessionId);
  }

  getSessionMember(sessionId: string, memberId: string): SessionMember | null {
    return getSessionMember(this.db, sessionId, memberId);
  }

  updateSessionMember(sessionId: string, memberId: string, patch: SessionMemberPatch): void {
    updateSessionMember(this.db, sessionId, memberId, patch);
  }

  deleteSessionMember(sessionId: string, memberId: string): void {
    deleteSessionMember(this.db, sessionId, memberId);
  }

  deleteSessionMembers(sessionId: string): void {
    deleteSessionMembers(this.db, sessionId);
  }

  deleteWorkplaceProject(id: string): boolean {
    return deleteWorkplaceProject(this.sqlite, id);
  }

  clearMessages(id: string): number {
    return clearMessages(this.sqlite, this.db, id);
  }

  /** Spill a tool result's full pre-truncation output, keyed by (transcript target, provider
   *  tool-call id). Idempotent per key (a replayed/re-run call with the same id overwrites). */
  saveToolRawOutput(sessionId: string, toolCallId: string, output: string): void {
    this.sqlite
      .query(
        `INSERT INTO tool_raw_outputs (transcript_target_id, tool_call_id, output, created_at)
         VALUES ($sid, $tid, $out, $at)
         ON CONFLICT(transcript_target_id, tool_call_id) DO UPDATE SET output = excluded.output, created_at = excluded.created_at`
      )
      .run({ $sid: sessionId, $tid: toolCallId, $out: output, $at: new Date().toISOString() });
  }

  /** Read a spilled tool output by handle, scoped to exactly this transcript target. Branching
   *  copies spills alongside messages (see cloneToolRawOutputs) — copy semantics, matching how
   *  session branching clones history rather than sharing it by lineage. Returns null when no
   *  spill exists for that id in this transcript. */
  getToolRawOutput(sessionId: string, toolCallId: string): string | null {
    const row = this.sqlite
      .query('SELECT output FROM tool_raw_outputs WHERE transcript_target_id = ? AND tool_call_id = ?')
      .get(sessionId, toolCallId) as { output: string } | null;
    return row?.output ?? null;
  }

  /** Copy the source transcript's spilled tool outputs referenced by the given tool-call ids into a
   *  branch child — cloneMessages copies tool_call rows with their toolCallIds intact, so the child's
   *  read_tool_output handles must resolve against its own transcript id. */
  cloneToolRawOutputs(sourceId: string, targetId: string, toolCallIds: readonly string[]): void {
    if (toolCallIds.length === 0) return;
    const placeholders = toolCallIds.map(() => '?').join(', ');
    this.sqlite
      .query(
        `INSERT OR REPLACE INTO tool_raw_outputs (transcript_target_id, tool_call_id, output, created_at)
         SELECT ?, tool_call_id, output, created_at FROM tool_raw_outputs
         WHERE transcript_target_id = ? AND tool_call_id IN (${placeholders})`
      )
      .run(targetId, sourceId, ...toolCallIds);
  }
  /** Accumulate one turn's REAL usage + cost into a session (per-session, resettable). Missing
   *  fields contribute 0 (presence ≠ value — never invent). */
  addUsage(id: string, usage: TokenUsage, costUsd = 0): void {
    addUsage(this.sqlite, id, usage, costUsd);
  }

  /** Accumulate one operation into the global usage ledger (see ./stats.ts). */
  recordLedger(provider: string, model: string, category: LedgerCategory, usage: TokenUsage, costUsd = 0): void {
    recordLedger(this.sqlite, provider, model, category, usage, costUsd);
  }

  ledger(): LedgerEntry[] {
    return ledger(this.sqlite);
  }

  ledgerBreakdown(): LedgerBreakdownRow[] {
    return ledgerBreakdown(this.sqlite);
  }

  clearLedger(): void {
    clearLedger(this.sqlite);
  }

  stats(range: StatsRange = 'all'): GetStatsResponse {
    return computeStats(this.sqlite, range);
  }

  insertTask(t: Task): void {
    insertTask(this.db, t);
  }

  /** Optimistic-concurrency CAS on `version`; returns true iff the row was updated. */
  casTaskState(id: string, expectedVersion: number, next: TaskState, updatedAt: string): boolean {
    return casTaskState(this.sqlite, id, expectedVersion, next, updatedAt);
  }

  insertMessage(
    id: string,
    transcriptTargetId: string,
    text: string,
    createdAt: string,
    role: ChatMessage['role'] = 'user',
    opts: { type?: MessageType; data?: unknown; streamStatus?: StreamStatus; includeInContext?: boolean } = {}
  ): void {
    insertMessage(this.db, id, transcriptTargetId, text, createdAt, role, opts);
  }

  cloneMessages(transcriptTargetId: SessionId, sourceMessages: readonly ChatMessage[]): Map<MessageId, MessageId> {
    return cloneMessages(this.sqlite, this.db, transcriptTargetId, sourceMessages);
  }

  messageSeq(transcriptTargetId: string, messageId: string): number {
    return messageSeq(this.sqlite, transcriptTargetId, messageId);
  }

  /** Advance a generative message's lifecycle, rejecting illegal/backward transitions
   * (anything leaving a terminal `complete`/`error`). Optionally set the final `text`/`data` in the
   * same write (so a `complete` transition lands the settled content atomically). Returns false if
   * the row is missing or the transition is disallowed. */
  setGenStatus(
    transcriptTargetId: string,
    messageId: string,
    next: StreamStatus,
    updatedAt: string,
    content?: { text?: string; data?: unknown; type?: MessageType; includeInContext?: boolean; createdAt?: string }
  ): boolean {
    return setGenStatus(this.sqlite, transcriptTargetId, messageId, next, updatedAt, content);
  }

  /** On daemon startup, terminally fail any rows left mid-stream by a crash/restart. Their turn is
   * dead and can never resume, so a client that sees `pending`/`streaming` would subscribe to a gone
   * stream and hang. Flipping them to `error` makes clients render from the row (terminal) instead;
   * excluding them from context keeps a half/empty turn out of later prompts. Returns the row count.
   * Safe because a freshly-started daemon has no live turns — every in-flight row is orphaned. */
  failOrphanedStreamingMessages(updatedAt: string): number {
    return failOrphanedStreamingMessages(this.sqlite, updatedAt);
  }

  /** Ordered by sqlite rowid (insertion order). Defaults to active (non-rewound) messages only. */
  listMessages(transcriptTargetId: string, opts: ListMessagesOptions = {}): ChatMessage[] {
    return listMessages(this.sqlite, transcriptTargetId, opts);
  }

  getMessage(transcriptTargetId: string, messageId: string): ChatMessage | null {
    return getMessage(this.sqlite, transcriptTargetId, messageId);
  }

  findManagedExternalAgentStreamingMessage(
    transcriptTargetId: string,
    externalAgentSessionId: string,
    agentName: string
  ): string | null {
    return findManagedExternalAgentStreamingMessage(this.sqlite, transcriptTargetId, externalAgentSessionId, agentName);
  }

  retireManagedExternalAgentStreamingMessage(
    transcriptTargetId: string,
    messageId: string,
    externalAgentSessionId: string,
    agentName: string,
    updatedAt = new Date().toISOString()
  ): boolean {
    return retireManagedExternalAgentStreamingMessage(
      this.sqlite,
      transcriptTargetId,
      messageId,
      externalAgentSessionId,
      agentName,
      updatedAt
    );
  }

  /** Global lookup of a LIVE message's text by id (no session needed). Used to trace a graph edge
   *  back to the source message it was extracted from (the bottom of the "why do you believe X"
   *  chain) — `active = 1` so a soft-deleted message can't resurface before the next reconcile. */
  getMessageText(messageId: string): string | null {
    return getMessageText(this.sqlite, messageId);
  }

  /** Per-session durable key/value (the `memory` table). Returns null when unset. */
  getMemory(sessionId: string, key: string): string | null {
    return getMemory(this.sqlite, sessionId, key);
  }

  /** Upsert a per-session durable key/value. */
  setMemory(sessionId: string, key: string, value: string): void {
    setMemory(this.sqlite, sessionId, key, value);
  }

  recordFileObservation(sessionId: string, observation: FileObservationRow): void {
    recordFileObservation(this.sqlite, sessionId, observation);
  }

  getFileObservation(sessionId: string, path: string): FileObservationRow | null {
    return getFileObservation(this.sqlite, sessionId, path);
  }

  clearFileObservations(sessionId: string): number {
    return clearFileObservations(this.sqlite, sessionId);
  }

  /**
   * Soft-delete (active=0) `toMessageId` and everything after it, bumps restore_count.
   * Caller must validate that `toMessageId` exists and is a user message.
   */
  restoreMessages(sessionId: string, toMessageId: string): { restoredCount: number; newHeadMessageId: string | null } {
    return restoreMessages(this.sqlite, sessionId, toMessageId);
  }

  /**
   * FTS5 (tokenized) + trigram (substring/CJK, queries ≥3 chars) + LIKE fallback.
   * `mode` semantic/hybrid degrade to keyword until embeddings are configured.
   */
  searchMessages(opts: SearchOptions): SearchHit[] {
    return searchMessages(this.sqlite, opts);
  }

  /** Store/replace a message's embedding vector (raw little-endian float32 bytes). `model` records
   *  which embedding model produced it, so a later model switch can detect stale vectors. */
  upsertEmbedding(messageId: string, vec: number[], model?: string): void {
    upsertEmbedding(this.sqlite, messageId, vec, model);
  }

  /** Drop every stored embedding (used when the embedding model changes and the user opts to
   *  re-index from scratch). Returns how many vectors were cleared; the indexer then rebuilds. */
  clearEmbeddings(): number {
    return clearEmbeddings(this.sqlite);
  }

  /**
   * Active messages with no embedding yet. `limit` caps the batch — pass it for an unscoped
   * (whole-corpus) backfill so a single request can't materialize + embed the entire DB at
   * once; a session-scoped call is already bounded by that session and can omit it.
   */
  messagesMissingEmbedding(transcriptTargetId?: string, limit?: number): { id: string; text: string }[] {
    return messagesMissingEmbedding(this.sqlite, transcriptTargetId, limit);
  }

  /** How many active, non-empty messages still lack an embedding — surfaced as an "indexing N
   *  left" hint so a semantic search can tell the user recall may be incomplete. */
  pendingEmbeddingCount(transcriptTargetId?: string): number {
    return pendingEmbeddingCount(this.sqlite, transcriptTargetId);
  }

  /** How many stored vectors were produced by a model OTHER than `currentModel` — i.e. stale after
   *  an embedding-model switch. Vectors with an unknown (NULL) model are not counted as stale. */
  staleEmbeddingCount(currentModel: string): number {
    return staleEmbeddingCount(this.sqlite, currentModel);
  }

  searchSemantic(queryVec: number[], opts: SearchSemanticOptions = {}): SearchHit[] {
    return searchSemantic(this.sqlite, queryVec, opts);
  }

  /** Idempotent on id (INSERT OR IGNORE). */
  appendEvents(batch: Event[]): void {
    appendEvents(this.sqlite, batch);
  }

  /** Find approval/clarify requests that have no matching resolved event (left dangling by a restart). */
  findDanglingInterrupts(): DanglingInterrupt[] {
    return findDanglingInterrupts(this.sqlite);
  }

  /** True when `eventId` is present in the durable event log. Lets callers distinguish a persisted
   *  cursor from an un-persisted live one (e.g. an `agent.token`) before calling {@link listEvents},
   *  whose missing-cursor fallback would otherwise replay the whole session. */
  hasEvent(eventId: string): boolean {
    return hasEvent(this.sqlite, eventId);
  }

  /** Exclusive cursor; falls back to the whole session if `afterEventId` is not in the log. */
  listEvents(sessionId: string, afterEventId?: string): Event[] {
    return listEvents(this.sqlite, sessionId, afterEventId);
  }

  getActiveConversation(channelId: string, conversationKey: string): ChannelConversation | null {
    return getActiveConversation(this.sqlite, channelId, conversationKey);
  }

  /** Repoint a conversation at `sessionId`, recording it in the history index. Upsert. */
  setActiveSession(args: SetActiveSessionArgs): void {
    setActiveSession(this.sqlite, args);
  }

  touchConversation(channelId: string, conversationKey: string): void {
    touchConversation(this.sqlite, channelId, conversationKey);
  }

  listConversationSessions(channelId: string, conversationKey: string): ChannelConversationSession[] {
    return listConversationSessions(this.sqlite, channelId, conversationKey);
  }

  countActiveConversations(channelId: string): number {
    return countActiveConversations(this.sqlite, channelId);
  }

  listActiveConversations(channelId: string): Array<{ conversationKey: string; activeSessionId: string }> {
    return listActiveConversations(this.sqlite, channelId);
  }

  // ── ACP Delegate Ledger ────────────────────────────────────────────────────────────────────────

  /** Insert a new live-delegate row on spawn. Upsert-safe: a re-spawn after eviction gets a fresh row. */
  upsertAcpDelegate(row: Omit<AcpDelegateRow, 'evictedAt' | 'evictReason' | 'reuseCount' | 'promptCount'>): void {
    upsertAcpDelegate(this.sqlite, row);
  }

  /** Update stats after a successful prompt (called in promptDelegate's finally block).
   *  Returns true if a live row was updated, false if the row was already evicted or missing. */
  touchAcpDelegate(id: string, lastUsedAt: string, reuseCount: number, promptCount: number): boolean {
    return touchAcpDelegate(this.sqlite, id, lastUsedAt, reuseCount, promptCount);
  }

  /** Mark a delegate as evicted (either by explicit eviction or daemon restart cleanup). */
  closeAcpDelegate(id: string, evictedAt: string, reason: string): void {
    closeAcpDelegate(this.sqlite, id, evictedAt, reason);
  }

  /** All rows where evicted_at IS NULL — i.e. delegates that were live when the daemon last ran.
   *  Used at startup to detect and kill orphaned adapter processes. */
  listLiveAcpDelegates(): AcpDelegateRow[] {
    return listLiveAcpDelegates(this.sqlite);
  }

  /** Recent delegate history for a session (live + evicted), newest first. */
  listAcpDelegatesForSession(sessionId: string, limit = 50): AcpDelegateRow[] {
    return listAcpDelegatesForSession(this.sqlite, sessionId, limit);
  }

  /** Delete rows evicted more than `olderThanMs` milliseconds ago. Returns deleted count. */
  pruneOldAcpDelegates(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    return pruneOldAcpDelegates(this.sqlite, olderThanMs);
  }

  /**
   * On daemon startup: close every delegate row that was live when the daemon last stopped (evicted_at
   * NULL), attempt to kill their adapter processes (best-effort — the PIDs may already be dead), and
   * mark them evicted. Returns how many rows were closed.
   *
   * Call ONCE, early, before any new delegates are spawned.
   */
  reconcileOrphanedDelegates(): number {
    return reconcileOrphanedDelegates(this.sqlite);
  }

  // ── External agent Session Ledger ─────────────────────────────────────────────────────────────────

  upsertExternalAgentSession(row: ExternalAgentSessionRow): void {
    upsertExternalAgentSession(this.sqlite, row);
  }

  getExternalAgentSession(id: string): ExternalAgentSessionRow | null {
    return getExternalAgentSession(this.sqlite, id);
  }

  listExternalAgentSessionsForTranscriptTarget(transcriptTargetId: string): ExternalAgentSessionRow[] {
    return listExternalAgentSessionsForTranscriptTarget(this.sqlite, transcriptTargetId);
  }

  listExternalAgentSessions(): ExternalAgentSessionRow[] {
    return listExternalAgentSessions(this.sqlite);
  }

  listLiveExternalAgentSessions(): ExternalAgentSessionRow[] {
    return listLiveExternalAgentSessions(this.sqlite);
  }

  appendExternalAgentOutput(id: string, chunk: string, maxSnapshotBytes = 256 * 1024): boolean {
    return appendExternalAgentOutput(this.sqlite, id, chunk, maxSnapshotBytes);
  }

  /** Overwrite the whole snapshot (no read-modify-write). The host buffers output in memory and
   *  flushes the bounded snapshot here on a timer, so the per-chunk path never touches SQLite. */
  setExternalAgentOutputSnapshot(id: string, snapshot: string, maxSnapshotBytes = 256 * 1024): boolean {
    return setExternalAgentOutputSnapshot(this.sqlite, id, snapshot, maxSnapshotBytes);
  }

  /** Delete terminal (exited/failed/stopped) sessions older than `olderThanMs`. Bounds table growth
   *  — one row per CLI launch, each carrying up to 256 KB of snapshot. Returns deleted count. */
  pruneExitedExternalAgentSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    return pruneExitedExternalAgentSessions(this.sqlite, olderThanMs);
  }

  updateExternalAgentSessionRef(id: string, providerSessionRef: string): boolean {
    return updateExternalAgentSessionRef(this.sqlite, id, providerSessionRef);
  }

  clearExternalAgentSessionRef(id: string): boolean {
    return clearExternalAgentSessionRef(this.sqlite, id);
  }

  setExternalAgentVisibleCursor(id: string, seq: number): boolean {
    return setExternalAgentVisibleCursor(this.sqlite, id, seq);
  }

  setExternalAgentDeliveredCursor(id: string, seq: number): boolean {
    return setExternalAgentDeliveredCursor(this.sqlite, id, seq);
  }

  enqueueExternalAgentInboxItem(
    externalAgentSessionId: string,
    messageSeq: number,
    createdAtOrOptions: string | EnqueueExternalAgentInboxOptions = new Date().toISOString()
  ): boolean {
    return enqueueExternalAgentInboxItem(this.sqlite, externalAgentSessionId, messageSeq, createdAtOrOptions);
  }

  markExternalAgentInboxDelivered(
    externalAgentSessionId: string,
    cursor: number,
    at = new Date().toISOString()
  ): boolean {
    return markExternalAgentInboxDelivered(this.sqlite, externalAgentSessionId, cursor, at);
  }

  markExternalAgentInboxVisible(
    externalAgentSessionId: string,
    cursor: number,
    at = new Date().toISOString()
  ): boolean {
    return markExternalAgentInboxVisible(this.sqlite, externalAgentSessionId, cursor, at);
  }

  markExternalAgentInboxConsumed(
    externalAgentSessionId: string,
    cursor: number,
    at = new Date().toISOString()
  ): boolean {
    return markExternalAgentInboxConsumed(this.sqlite, externalAgentSessionId, cursor, at);
  }

  hasUnconsumedExternalAgentInbox(externalAgentSessionId: string, cursor?: number): boolean {
    return hasUnconsumedExternalAgentInbox(this.sqlite, externalAgentSessionId, cursor);
  }

  maxMessageSeq(sessionId: string): number {
    return maxMessageSeq(this.sqlite, sessionId);
  }

  maxMessageCreatedAt(sessionId: string): string | null {
    return maxMessageCreatedAt(this.sqlite, sessionId);
  }

  messageIdForSeq(transcriptTargetId: SessionId, seq: number): MessageId | null {
    return messageIdForSeq(this.sqlite, transcriptTargetId, seq);
  }

  listExternalAgentInbox(externalAgentSessionId: string, limit = 50): ExternalAgentInboxItem[] {
    return listExternalAgentInbox(this.sqlite, externalAgentSessionId, limit);
  }

  listMentionInbox(limit = 100): InboxItem[] {
    return listMentionInbox(this.sqlite, limit);
  }

  countExternalAgentInbox(externalAgentSessionId: string): number {
    return countExternalAgentInbox(this.sqlite, externalAgentSessionId);
  }

  getNativeAgentDelivery(deliveryId: NativeAgentDeliveryId): NativeAgentDelivery | null {
    return getNativeAgentDelivery(this.sqlite, deliveryId);
  }

  insertNativeAgentDirectMessage(row: NativeAgentDirectMessage): void {
    insertNativeAgentDirectMessage(this.sqlite, row);
  }

  /** Register a message's file reference. Only the reference + a metadata snapshot is stored;
   *  content stays in the file. Registration also gates the wall preview/download endpoint. */
  registerMessageAttachment(att: MessageAttachmentInsert): MessageAttachmentRef {
    return registerMessageAttachment(this.sqlite, att);
  }

  /** Register a message's file references atomically: either all rows land or none. */
  registerMessageAttachments(atts: readonly MessageAttachmentInsert[]): MessageAttachmentRef[] {
    return registerMessageAttachments(this.sqlite, atts);
  }

  /** Roll back registrations whose message never landed (keeps the "registered = referenced by a
   *  message" gate on the client-facing read endpoint honest). */
  deleteMessageAttachments(ids: readonly string[]): void {
    deleteMessageAttachments(this.sqlite, ids);
  }

  getMessageAttachment(id: string): MessageAttachmentDetail | null {
    return getMessageAttachment(this.sqlite, id);
  }

  /** Batch-hydrate refs for a set of ids in one query (column-projected — no preview blobs).
   *  Missing ids are simply absent from the map. */
  getMessageAttachmentRefs(ids: readonly string[]): Map<string, MessageAttachmentRef> {
    return getMessageAttachmentRefs(this.sqlite, ids);
  }

  listNativeAgentDirectMessages(
    externalAgentSessionId: string,
    peer: string,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): NativeAgentDirectMessage[] {
    return listNativeAgentDirectMessages(this.sqlite, externalAgentSessionId, peer, opts);
  }

  closeExternalAgentSession(
    id: string,
    exitedAt: string,
    exitCode: number | null,
    state: 'exited' | 'failed' | 'stopped' = 'exited'
  ): boolean {
    return closeExternalAgentSession(this.sqlite, id, exitedAt, exitCode, state);
  }

  reconcileOrphanedExternalAgentSessions(
    killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')
  ): number {
    return reconcileOrphanedExternalAgentSessions(this.sqlite, killPid);
  }

  close(): void {
    if (this.#checkpoint) {
      stopWalCheckpoint(this.#checkpoint);
      this.#checkpoint = undefined;
    }
    this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.sqlite.close();
  }
}

export function createStore(opts?: StoreOptions): Store {
  return new Store(opts);
}

export { factId, MemoryDir, projectKey, scopeOf } from './memory-dir.ts';
