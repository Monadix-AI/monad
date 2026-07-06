import type {
  ChatMessage,
  Event,
  GetStatsResponse,
  LedgerCategory,
  MessageAttachmentRef,
  MessageId,
  MessageType,
  NativeAgentDelivery,
  NativeAgentDeliveryId,
  NativeAgentDirectMessage,
  NativeCliInboxItem,
  SearchHit,
  Session,
  SessionState,
  StatsRange,
  StreamStatus,
  Task,
  TaskState,
  TokenUsage,
  TranscriptTargetId,
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
  type MessageAttachmentInsert,
  registerMessageAttachment,
  registerMessageAttachments
} from './attachments.ts';
import {
  countActiveConversations,
  getActiveConversation,
  listActiveConversations,
  listConversationSessions,
  setActiveSession,
  touchConversation
} from './channels.ts';
import { appendEvents, findDanglingInterrupts, hasEvent, listEvents } from './events.ts';
import {
  failOrphanedStreamingMessages,
  findManagedNativeCliStreamingMessage,
  getMemory,
  getMessage,
  getMessageText,
  insertMessage,
  type ListMessagesOptions,
  listMessages,
  listMessagesWithLineage,
  maxMessageCreatedAt,
  maxMessageSeq,
  messageIdForSeq,
  messageSeq,
  restoreMessages,
  retireManagedNativeCliStreamingMessage,
  setGenStatus,
  setMemory
} from './messages.ts';
import { migrate } from './migrations.ts';
import { insertNativeAgentDirectMessage, listNativeAgentDirectMessages } from './native-agent-messages.ts';
import {
  countNativeCliInbox,
  type EnqueueNativeCliInboxOptions,
  enqueueNativeCliInboxItem,
  getNativeAgentDelivery,
  hasUnconsumedNativeCliInbox,
  listNativeCliInbox,
  markNativeCliInboxConsumed,
  markNativeCliInboxDelivered,
  markNativeCliInboxVisible
} from './native-cli-inbox.ts';
import {
  appendNativeCliOutput,
  clearNativeCliSessionRef,
  closeNativeCliSession,
  getNativeCliSession,
  listLiveNativeCliSessions,
  listNativeCliSessions,
  listNativeCliSessionsForTranscriptTarget,
  type NativeCliSessionRow,
  pruneExitedNativeCliSessions,
  reconcileOrphanedNativeCliSessions,
  setNativeCliDeliveredCursor,
  setNativeCliOutputSnapshot,
  setNativeCliVisibleCursor,
  updateNativeCliSessionRef,
  upsertNativeCliSession
} from './native-cli-sessions.ts';
import { tasks } from './schema.ts';
import {
  clearEmbeddings,
  messagesMissingEmbedding,
  pendingEmbeddingCount,
  type SearchOptions,
  searchMessages,
  searchSemantic,
  staleEmbeddingCount,
  upsertEmbedding
} from './search.ts';
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
  provenance,
  updateSession,
  updateWorkplaceProject
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

export type { ChatMessage } from '@monad/protocol';
export type { AcpDelegateRow } from './acp-delegates.ts';
export type { ListMessagesOptions } from './messages.ts';
export type { EnqueueNativeCliInboxOptions } from './native-cli-inbox.ts';
export type { NativeCliSessionRow } from './native-cli-sessions.ts';
export type { ChannelConversation, ChannelConversationSession } from './row-mappers.ts';
export type { SearchOptions } from './search.ts';
export type { ListSessionsFilter } from './sessions.ts';
export type { LedgerBreakdownRow, LedgerEntry } from './stats.ts';

export interface StoreOptions {
  /** File path, or ":memory:" for an ephemeral in-process DB (the default). */
  path?: string;
}

export class Store {
  private readonly sqlite: Database;
  readonly db: BunSQLiteDatabase<Record<string, never>>;
  #checkpointTimer: ReturnType<typeof setInterval> | undefined;
  #checkpointWorker: Worker | undefined;

  constructor(opts: StoreOptions = {}) {
    this.sqlite = new Database(opts.path ?? ':memory:');
    // Connection-level PRAGMAs applied on every open (not persisted reliably across connections).
    // WAL mode is set in the migration (persisted to the DB header); these complement it.
    // synchronous=NORMAL is safe with WAL: each committed WAL frame is durable; only the periodic
    // checkpoint loses the extra fsync of FULL, which is acceptable for a local single-user daemon.
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec('PRAGMA synchronous = NORMAL');
    migrate(this.sqlite);
    this.db = drizzle(this.sqlite);
    if (opts.path && opts.path !== ':memory:') {
      // Run WAL checkpoints in a Worker so the periodic fsync (which can stall 10-100ms on busy
      // WAL files) does not block the daemon's main event loop mid-request. The worker is a pure
      // optimization: if it can't be created or loaded — `new Worker(new URL(…, import.meta.url))`
      // fails to resolve the embedded script in a bun --compile binary on some platforms (Windows),
      // surfacing as "Worker has been terminated" — degrade silently. SQLite still auto-checkpoints
      // the WAL at its page threshold, so correctness is unaffected; we only lose the offloaded fsync.
      const dbPath = opts.path;
      try {
        const worker = new Worker(new URL('./workers/wal-checkpoint.ts', import.meta.url));
        worker.addEventListener('error', () => {
          this.#checkpointWorker = undefined;
        });
        this.#checkpointWorker = worker;
        this.#checkpointTimer = setInterval(
          () => {
            try {
              this.#checkpointWorker?.postMessage({ type: 'checkpoint', path: dbPath });
            } catch {
              this.#checkpointWorker = undefined;
            }
          },
          5 * 60 * 1000
        );
        this.#checkpointTimer.unref();
      } catch {
        this.#checkpointWorker = undefined;
      }
    }
  }

  getSchemaVersion(): number {
    const row = this.sqlite.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
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
  updateSession(
    id: string,
    patch: {
      title?: string;
      state?: SessionState;
      archived?: boolean;
      agentIds?: Session['agentIds'];
      model?: string | null;
      cwd?: string | null;
      origin?: Session['origin'] | null;
    }
  ): Session | null {
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

  updateWorkplaceProject(
    id: string,
    patch: {
      title?: string;
      state?: SessionState;
      archived?: boolean;
      model?: string | null;
      cwd?: string | null;
      origin?: WorkplaceProject['origin'] | null;
    }
  ): WorkplaceProject | null {
    return updateWorkplaceProject(this.db, id, patch);
  }

  deleteWorkplaceProject(id: string): boolean {
    return deleteWorkplaceProject(this.sqlite, id);
  }

  clearMessages(id: string): number {
    return clearMessages(this.sqlite, this.db, id);
  }

  /** Ancestors (root-first) + BFS descendants. Excludes `id` itself — caller adds it. */
  provenance(id: string): { ancestors: Session[]; descendants: Session[] } {
    return provenance(this.sqlite, this.db, id);
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
    this.db
      .insert(tasks)
      .values({
        ...t,
        dependsOn: JSON.stringify(t.dependsOn),
        result: t.result !== undefined ? JSON.stringify(t.result) : null,
        error: t.error !== undefined ? JSON.stringify(t.error) : null
      })
      .run();
  }

  /** Optimistic-concurrency CAS on `version`; returns true iff the row was updated. */
  casTaskState(id: string, expectedVersion: number, next: TaskState, updatedAt: string): boolean {
    const result = this.sqlite
      .query(
        'UPDATE tasks SET state=$next, version=version+1, updated_at=$updatedAt WHERE id=$id AND version=$expected'
      )
      .run({ $next: next, $updatedAt: updatedAt, $id: id, $expected: expectedVersion });
    return result.changes === 1;
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

  /**
   * Full history for a session INCLUDING inherited ancestor messages, root-first, with each
   * ancestor truncated at the branch point its child forked from. For a root (non-branched)
   * session this is exactly `listMessages`. The agent loop uses this so a branched session sees
   * its parent context, and the `sessions.messages` includeAncestors view shares the same logic.
   */
  listMessagesWithLineage(sessionId: string, opts: { includeInactive?: boolean; after?: string } = {}): ChatMessage[] {
    return listMessagesWithLineage(this.sqlite, this.db, sessionId, opts);
  }

  getMessage(transcriptTargetId: string, messageId: string): ChatMessage | null {
    return getMessage(this.sqlite, transcriptTargetId, messageId);
  }

  findManagedNativeCliStreamingMessage(
    transcriptTargetId: string,
    nativeCliSessionId: string,
    agentName: string
  ): string | null {
    return findManagedNativeCliStreamingMessage(this.sqlite, transcriptTargetId, nativeCliSessionId, agentName);
  }

  retireManagedNativeCliStreamingMessage(
    transcriptTargetId: string,
    messageId: string,
    nativeCliSessionId: string,
    agentName: string,
    updatedAt = new Date().toISOString()
  ): boolean {
    return retireManagedNativeCliStreamingMessage(
      this.sqlite,
      transcriptTargetId,
      messageId,
      nativeCliSessionId,
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

  searchSemantic(
    queryVec: number[],
    opts: { limit?: number; transcriptTargetId?: TranscriptTargetId } = {}
  ): SearchHit[] {
    return searchSemantic(this.sqlite, queryVec, opts);
  }

  /** Idempotent on id (INSERT OR IGNORE). */
  appendEvents(batch: Event[]): void {
    appendEvents(this.sqlite, batch);
  }

  /** Find approval/clarify requests that have no matching resolved event (left dangling by a restart). */
  findDanglingInterrupts(): Array<{
    type: 'approval' | 'clarify';
    requestId: string;
    sessionId: string;
    tool?: string;
  }> {
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
  setActiveSession(args: {
    channelId: string;
    conversationKey: string;
    sessionId: string;
    principalId: string;
    label?: string;
  }): void {
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

  // ── Native CLI Session Ledger ─────────────────────────────────────────────────────────────────

  upsertNativeCliSession(row: NativeCliSessionRow): void {
    upsertNativeCliSession(this.sqlite, row);
  }

  getNativeCliSession(id: string): NativeCliSessionRow | null {
    return getNativeCliSession(this.sqlite, id);
  }

  listNativeCliSessionsForTranscriptTarget(transcriptTargetId: string): NativeCliSessionRow[] {
    return listNativeCliSessionsForTranscriptTarget(this.sqlite, transcriptTargetId);
  }

  listNativeCliSessions(): NativeCliSessionRow[] {
    return listNativeCliSessions(this.sqlite);
  }

  listLiveNativeCliSessions(): NativeCliSessionRow[] {
    return listLiveNativeCliSessions(this.sqlite);
  }

  appendNativeCliOutput(id: string, chunk: string, maxSnapshotBytes = 256 * 1024): boolean {
    return appendNativeCliOutput(this.sqlite, id, chunk, maxSnapshotBytes);
  }

  /** Overwrite the whole snapshot (no read-modify-write). The host buffers output in memory and
   *  flushes the bounded snapshot here on a timer, so the per-chunk path never touches SQLite. */
  setNativeCliOutputSnapshot(id: string, snapshot: string, maxSnapshotBytes = 256 * 1024): boolean {
    return setNativeCliOutputSnapshot(this.sqlite, id, snapshot, maxSnapshotBytes);
  }

  /** Delete terminal (exited/failed/stopped) sessions older than `olderThanMs`. Bounds table growth
   *  — one row per CLI launch, each carrying up to 256 KB of snapshot. Returns deleted count. */
  pruneExitedNativeCliSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    return pruneExitedNativeCliSessions(this.sqlite, olderThanMs);
  }

  updateNativeCliSessionRef(id: string, providerSessionRef: string): boolean {
    return updateNativeCliSessionRef(this.sqlite, id, providerSessionRef);
  }

  clearNativeCliSessionRef(id: string): boolean {
    return clearNativeCliSessionRef(this.sqlite, id);
  }

  setNativeCliVisibleCursor(id: string, seq: number): boolean {
    return setNativeCliVisibleCursor(this.sqlite, id, seq);
  }

  setNativeCliDeliveredCursor(id: string, seq: number): boolean {
    return setNativeCliDeliveredCursor(this.sqlite, id, seq);
  }

  enqueueNativeCliInboxItem(
    nativeCliSessionId: string,
    messageSeq: number,
    createdAtOrOptions: string | EnqueueNativeCliInboxOptions = new Date().toISOString()
  ): boolean {
    return enqueueNativeCliInboxItem(this.sqlite, nativeCliSessionId, messageSeq, createdAtOrOptions);
  }

  markNativeCliInboxDelivered(nativeCliSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    return markNativeCliInboxDelivered(this.sqlite, nativeCliSessionId, cursor, at);
  }

  markNativeCliInboxVisible(nativeCliSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    return markNativeCliInboxVisible(this.sqlite, nativeCliSessionId, cursor, at);
  }

  markNativeCliInboxConsumed(nativeCliSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    return markNativeCliInboxConsumed(this.sqlite, nativeCliSessionId, cursor, at);
  }

  hasUnconsumedNativeCliInbox(nativeCliSessionId: string, cursor?: number): boolean {
    return hasUnconsumedNativeCliInbox(this.sqlite, nativeCliSessionId, cursor);
  }

  maxMessageSeq(sessionId: string): number {
    return maxMessageSeq(this.sqlite, sessionId);
  }

  maxMessageCreatedAt(sessionId: string): string | null {
    return maxMessageCreatedAt(this.sqlite, sessionId);
  }

  messageIdForSeq(transcriptTargetId: TranscriptTargetId, seq: number): MessageId | null {
    return messageIdForSeq(this.sqlite, transcriptTargetId, seq);
  }

  listNativeCliInbox(nativeCliSessionId: string, limit = 50): NativeCliInboxItem[] {
    return listNativeCliInbox(this.sqlite, nativeCliSessionId, limit);
  }

  countNativeCliInbox(nativeCliSessionId: string): number {
    return countNativeCliInbox(this.sqlite, nativeCliSessionId);
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

  getMessageAttachment(
    id: string
  ): (MessageAttachmentRef & { projectId: string; preview: string; createdBy: string | null }) | null {
    return getMessageAttachment(this.sqlite, id);
  }

  /** Batch-hydrate refs for a set of ids in one query (column-projected — no preview blobs).
   *  Missing ids are simply absent from the map. */
  getMessageAttachmentRefs(ids: readonly string[]): Map<string, MessageAttachmentRef> {
    return getMessageAttachmentRefs(this.sqlite, ids);
  }

  listNativeAgentDirectMessages(
    nativeCliSessionId: string,
    peer: string,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): NativeAgentDirectMessage[] {
    return listNativeAgentDirectMessages(this.sqlite, nativeCliSessionId, peer, opts);
  }

  closeNativeCliSession(
    id: string,
    exitedAt: string,
    exitCode: number | null,
    state: 'exited' | 'failed' | 'stopped' = 'exited'
  ): boolean {
    return closeNativeCliSession(this.sqlite, id, exitedAt, exitCode, state);
  }

  reconcileOrphanedNativeCliSessions(killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')): number {
    return reconcileOrphanedNativeCliSessions(this.sqlite, killPid);
  }

  close(): void {
    if (this.#checkpointTimer) {
      clearInterval(this.#checkpointTimer);
      this.#checkpointTimer = undefined;
    }
    this.#checkpointWorker?.terminate();
    this.#checkpointWorker = undefined;
    this.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.sqlite.close();
  }
}

export function createStore(opts?: StoreOptions): Store {
  return new Store(opts);
}

export { factId, MemoryDir, projectKey, scopeOf } from './memory-dir.ts';
export { CURRENT_SCHEMA_VERSION } from './migrations.ts';
