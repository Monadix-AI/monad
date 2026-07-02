import type {
  ChannelInbound,
  ChannelResponseNextTarget,
  ChatMessage,
  Event,
  GetStatsResponse,
  LedgerCategory,
  MessageType,
  NativeAgentDirectMessage,
  NativeCliInboxDeliveryState,
  NativeCliInboxItem,
  NativeCliLaunchMode,
  NativeCliProvider,
  NativeCliRuntimeRole,
  NativeCliSessionState,
  SearchHit,
  SearchMode,
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

import { Database } from 'bun:sqlite';
import { persistedIncludeInContext } from '@monad/protocol';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';

import { migrate } from './migrations.ts';
import {
  type ChannelConversation,
  type ChannelConversationSession,
  type MessageRow,
  makeSnippet,
  rowToConversation,
  rowToMessage,
  rowToSession,
  rowToWorkplaceProject,
  type SearchRow,
  toIntFlag
} from './row-mappers.ts';
import { messages, sessions, tasks, workplaceProjects } from './schema.ts';
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
export type { ChannelConversation, ChannelConversationSession } from './row-mappers.ts';
export type { LedgerBreakdownRow, LedgerEntry } from './stats.ts';

/** A row from the acp_delegates table (camelCase). evictedAt=null means the delegate is live. */
export interface AcpDelegateRow {
  id: string;
  sessionId: string;
  agentName: string;
  acpSessionId: string;
  pid: number;
  spawnedAt: string;
  lastUsedAt: string;
  evictedAt: string | null;
  evictReason: string | null;
  reuseCount: number;
  promptCount: number;
}

export interface NativeCliSessionRow {
  id: string;
  transcriptTargetId: TranscriptTargetId;
  agentName: string;
  provider: NativeCliProvider;
  workingPath: string;
  launchMode: NativeCliLaunchMode;
  runtimeRole: NativeCliRuntimeRole;
  agentRuntimeId: string | null;
  agentRuntimeTokenHash: string | null;
  lastDeliveredSeq: number;
  lastVisibleSeq: number;
  state: NativeCliSessionState;
  pid: number | null;
  providerSessionRef: string | null;
  outputSnapshot: string;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
}

export interface ChannelModeratorRoundTask {
  index: number;
  agentId: string;
  agentName: string;
  title?: string;
  task: ChannelResponseNextTarget;
}

export interface ChannelModeratorRoundResult {
  index: number;
  agentId: string;
  agentName: string;
  title?: string;
  result: string;
  timedOut?: boolean;
}

export interface ChannelModeratorRoundRow {
  id: string;
  channelId: string;
  moderatorKey: string;
  moderatorAgentId: string;
  originalInbound: ChannelInbound;
  depth: number;
  tasks: ChannelModeratorRoundTask[];
  results: ChannelModeratorRoundResult[];
  status: 'open' | 'settled';
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

function rowToChannelModeratorRound(r: Record<string, unknown>): ChannelModeratorRoundRow {
  return {
    id: r.id as string,
    channelId: r.channel_id as string,
    moderatorKey: r.moderator_key as string,
    moderatorAgentId: r.moderator_agent_id as string,
    originalInbound: JSON.parse(r.original_inbound as string) as ChannelInbound,
    depth: r.depth as number,
    tasks: JSON.parse(r.tasks as string) as ChannelModeratorRoundTask[],
    results: JSON.parse(r.results as string) as ChannelModeratorRoundResult[],
    status: r.status as 'open' | 'settled',
    deadlineAt: r.deadline_at as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  };
}

function rowToNativeCliSession(r: Record<string, unknown>): NativeCliSessionRow {
  return {
    id: r.id as string,
    transcriptTargetId: r.transcript_target_id as TranscriptTargetId,
    agentName: r.agent_name as string,
    provider: r.provider as NativeCliProvider,
    workingPath: r.working_path as string,
    launchMode: r.launch_mode as NativeCliLaunchMode,
    runtimeRole: ((r.runtime_role as string | null) ?? 'interactive') as NativeCliRuntimeRole,
    agentRuntimeId: (r.agent_runtime_id as string | null) ?? null,
    agentRuntimeTokenHash: (r.agent_runtime_token_hash as string | null) ?? null,
    lastDeliveredSeq: (r.last_delivered_seq as number | null) ?? 0,
    lastVisibleSeq: (r.last_visible_seq as number | null) ?? 0,
    state: r.state as NativeCliSessionState,
    pid: (r.pid as number | null) ?? null,
    providerSessionRef: (r.provider_session_ref as string | null) ?? null,
    outputSnapshot: (r.output_snapshot as string | null) ?? '',
    exitCode: (r.exit_code as number | null) ?? null,
    startedAt: r.started_at as string,
    updatedAt: r.updated_at as string,
    exitedAt: (r.exited_at as string | null) ?? null
  };
}

export interface StoreOptions {
  /** File path, or ":memory:" for an ephemeral in-process DB (the default). */
  path?: string;
}

export interface ListSessionsFilter {
  archived?: boolean;
  state?: SessionState;
  limit?: number;
  offset?: number;
}

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

export interface SearchOptions {
  q: string;
  mode?: SearchMode;
  limit?: number;
  transcriptTargetId?: TranscriptTargetId;
}

function rowToAcpDelegate(r: Record<string, unknown>): AcpDelegateRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    agentName: r.agent_name as string,
    acpSessionId: r.acp_session_id as string,
    pid: r.pid as number,
    spawnedAt: r.spawned_at as string,
    lastUsedAt: r.last_used_at as string,
    evictedAt: (r.evicted_at as string | null) ?? null,
    evictReason: (r.evict_reason as string | null) ?? null,
    reuseCount: r.reuse_count as number,
    promptCount: r.prompt_count as number
  };
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
    this.db
      .insert(sessions)
      .values({
        id: s.id,
        title: s.title,
        ownerPrincipalId: s.ownerPrincipalId,
        state: s.state,
        agentIds: JSON.stringify(s.agentIds),
        parentSessionId: s.parentSessionId ?? null,
        branchedAtMessageId: s.branchedAtMessageId ?? null,
        archived: s.archived ? 1 : 0,
        restoreCount: s.restoreCount,
        model: s.model ?? null,
        cwd: s.cwd ?? null,
        origin: s.origin ? JSON.stringify(s.origin) : null,
        inputTokens: s.usage?.inputTokens ?? 0,
        outputTokens: s.usage?.outputTokens ?? 0,
        totalTokens: s.usage?.totalTokens ?? 0,
        cacheReadTokens: s.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: s.usage?.cacheWriteTokens ?? 0,
        reasoningTokens: s.usage?.reasoningTokens ?? 0,
        costUsd: s.costUsd ?? 0,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      })
      .run();
  }

  listSessions(filter: ListSessionsFilter = {}): Session[] {
    const conds = [];
    if (filter.archived !== undefined) conds.push(eq(sessions.archived, filter.archived ? 1 : 0));
    if (filter.state !== undefined) conds.push(eq(sessions.state, filter.state));
    const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
    const base = this.db.select().from(sessions).where(where).orderBy(desc(sessions.updatedAt), desc(sessions.id));
    const limited = filter.limit !== undefined ? base.limit(filter.limit) : base;
    const paged = filter.offset !== undefined ? limited.offset(filter.offset) : limited;
    return paged.all().map(rowToSession);
  }

  countSessions(filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
    const conds = [];
    if (filter.archived !== undefined) conds.push(eq(sessions.archived, filter.archived ? 1 : 0));
    if (filter.state !== undefined) conds.push(eq(sessions.state, filter.state));
    const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
    const result = this.db.select({ count: count() }).from(sessions).where(where).get();
    return result?.count ?? 0;
  }

  getSession(id: string): Session | null {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row ? rowToSession(row) : null;
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
    const sets: Partial<typeof sessions.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) sets.title = patch.title;
    if (patch.state !== undefined) sets.state = patch.state;
    if (patch.archived !== undefined) sets.archived = patch.archived ? 1 : 0;
    if (patch.agentIds !== undefined) sets.agentIds = JSON.stringify(patch.agentIds);
    if (patch.model !== undefined) sets.model = patch.model;
    if (patch.cwd !== undefined) sets.cwd = patch.cwd;
    if (patch.origin !== undefined) sets.origin = patch.origin ? JSON.stringify(patch.origin) : null;
    this.db.update(sessions).set(sets).where(eq(sessions.id, id)).run();
    return this.getSession(id);
  }

  deleteSession(id: string): boolean {
    const tx = this.sqlite.transaction((sid: string) => {
      this.sqlite
        .query(
          'DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE transcript_target_id = ?)'
        )
        .run(sid);
      this.sqlite.query('DELETE FROM tasks WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM memory WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM messages WHERE transcript_target_id = ?').run(sid);
      this.sqlite.query('DELETE FROM events WHERE transcript_target_id = ?').run(sid);
      this.sqlite.query('DELETE FROM acp_delegates WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM channel_conversation_sessions WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM channel_conversations WHERE active_session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM native_agent_direct_messages WHERE project_id = ?').run(sid);
      this.sqlite
        .query(
          `DELETE FROM native_cli_inbox_items
           WHERE native_cli_session_id IN (SELECT id FROM native_cli_sessions WHERE transcript_target_id = ?)`
        )
        .run(sid);
      this.sqlite.query('DELETE FROM native_cli_sessions WHERE transcript_target_id = ?').run(sid);
      return this.sqlite.query('DELETE FROM sessions WHERE id = ?').run(sid).changes;
    });
    return tx(id) > 0;
  }

  insertWorkplaceProject(project: WorkplaceProject): void {
    this.db
      .insert(workplaceProjects)
      .values({
        id: project.id,
        title: project.title,
        ownerPrincipalId: project.ownerPrincipalId,
        state: project.state,
        archived: project.archived ? 1 : 0,
        model: project.model ?? null,
        cwd: project.cwd ?? null,
        origin: project.origin ? JSON.stringify(project.origin) : null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      })
      .run();
  }

  listWorkplaceProjects(filter: ListSessionsFilter = {}): WorkplaceProject[] {
    const conds = [];
    if (filter.archived !== undefined) conds.push(eq(workplaceProjects.archived, filter.archived ? 1 : 0));
    if (filter.state !== undefined) conds.push(eq(workplaceProjects.state, filter.state));
    const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
    const base = this.db
      .select()
      .from(workplaceProjects)
      .where(where)
      .orderBy(desc(workplaceProjects.updatedAt), desc(workplaceProjects.id));
    const limited = filter.limit !== undefined ? base.limit(filter.limit) : base;
    const paged = filter.offset !== undefined ? limited.offset(filter.offset) : limited;
    return paged.all().map(rowToWorkplaceProject);
  }

  countWorkplaceProjects(filter: Omit<ListSessionsFilter, 'limit' | 'offset'> = {}): number {
    const conds = [];
    if (filter.archived !== undefined) conds.push(eq(workplaceProjects.archived, filter.archived ? 1 : 0));
    if (filter.state !== undefined) conds.push(eq(workplaceProjects.state, filter.state));
    const where = conds.length === 1 ? conds[0] : conds.length > 1 ? and(...conds) : undefined;
    return this.db.select({ count: count() }).from(workplaceProjects).where(where).get()?.count ?? 0;
  }

  getWorkplaceProject(id: string): WorkplaceProject | null {
    const row = this.db.select().from(workplaceProjects).where(eq(workplaceProjects.id, id)).get();
    return row ? rowToWorkplaceProject(row) : null;
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
    const sets: Partial<typeof workplaceProjects.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) sets.title = patch.title;
    if (patch.state !== undefined) sets.state = patch.state;
    if (patch.archived !== undefined) sets.archived = patch.archived ? 1 : 0;
    if (patch.model !== undefined) sets.model = patch.model;
    if (patch.cwd !== undefined) sets.cwd = patch.cwd;
    if (patch.origin !== undefined) sets.origin = patch.origin ? JSON.stringify(patch.origin) : null;
    this.db.update(workplaceProjects).set(sets).where(eq(workplaceProjects.id, id)).run();
    return this.getWorkplaceProject(id);
  }

  deleteWorkplaceProject(id: string): boolean {
    const tx = this.sqlite.transaction((projectId: string) => {
      this.sqlite
        .query(
          'DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE transcript_target_id = ?)'
        )
        .run(projectId);
      this.sqlite.query('DELETE FROM messages WHERE transcript_target_id = ?').run(projectId);
      this.sqlite.query('DELETE FROM events WHERE transcript_target_id = ?').run(projectId);
      this.sqlite.query('DELETE FROM native_agent_direct_messages WHERE project_id = ?').run(projectId);
      this.sqlite
        .query(
          `DELETE FROM native_cli_inbox_items
           WHERE native_cli_session_id IN (SELECT id FROM native_cli_sessions WHERE transcript_target_id = ?)`
        )
        .run(projectId);
      this.sqlite.query('DELETE FROM native_cli_sessions WHERE transcript_target_id = ?').run(projectId);
      return this.sqlite.query('DELETE FROM workplace_projects WHERE id = ?').run(projectId).changes;
    });
    return tx(id) > 0;
  }

  clearMessages(id: string): number {
    const tx = this.sqlite.transaction((sid: string) => {
      // Count BEFORE deleting: the messages table has AFTER-DELETE FTS triggers, and bun:sqlite's
      // `result.changes` includes trigger-affected rows — so a DELETE's `.changes` over-counts. A
      // direct COUNT(*) is the only reliable "how many messages did we clear" (drives /reset's reply).
      const row = this.sqlite.query('SELECT COUNT(*) AS n FROM messages WHERE transcript_target_id = ?').get(sid) as {
        n: number;
      };
      this.sqlite
        .query(
          'DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE transcript_target_id = ?)'
        )
        .run(sid);
      this.sqlite.query('DELETE FROM messages WHERE transcript_target_id = ?').run(sid);
      this.sqlite.query('DELETE FROM events WHERE transcript_target_id = ?').run(sid);
      this.sqlite.query("DELETE FROM memory WHERE session_id = ? AND key = 'ctx:summary'").run(sid);
      const updatedAt = new Date().toISOString();
      this.db.update(sessions).set({ updatedAt }).where(eq(sessions.id, sid)).run();
      this.db.update(workplaceProjects).set({ updatedAt }).where(eq(workplaceProjects.id, sid)).run();
      return row.n;
    });
    return tx(id);
  }

  /** Ancestors (root-first) + BFS descendants. Excludes `id` itself — caller adds it. */
  provenance(id: string): { ancestors: Session[]; descendants: Session[] } {
    if (!this.getSession(id)) return { ancestors: [], descendants: [] };

    // Collect ancestor IDs root-first via recursive CTE (depth DESC = farthest ancestor first).
    const ancIds = (
      this.sqlite
        .query(
          `WITH RECURSIVE anc(id, depth) AS (
             SELECT parent_session_id, 1 FROM sessions WHERE id = $id AND parent_session_id IS NOT NULL
             UNION ALL
             SELECT s.parent_session_id, anc.depth + 1
             FROM sessions s JOIN anc ON s.id = anc.id
             WHERE s.parent_session_id IS NOT NULL
           )
           SELECT id FROM anc ORDER BY depth DESC`
        )
        .all({ $id: id }) as { id: `ses_${string}` }[]
    ).map((r) => r.id);

    // Collect all descendant IDs via recursive CTE.
    const descIds = (
      this.sqlite
        .query(
          `WITH RECURSIVE desc(id) AS (
             SELECT id FROM sessions WHERE parent_session_id = $id
             UNION ALL
             SELECT s.id FROM sessions s JOIN desc ON s.parent_session_id = desc.id
           )
           SELECT id FROM desc ORDER BY id`
        )
        .all({ $id: id }) as { id: `ses_${string}` }[]
    ).map((r) => r.id);

    // Fetch full rows via drizzle (returns camelCase-mapped SessionRow) and re-apply CTE order.
    const fetchOrdered = (ids: `ses_${string}`[]): Session[] => {
      if (!ids.length) return [];
      const byId = new Map(
        this.db
          .select()
          .from(sessions)
          .where(inArray(sessions.id, ids))
          .all()
          .map(rowToSession)
          .map((s) => [s.id, s])
      );
      return ids.map((i) => byId.get(i)).filter((s): s is Session => s !== undefined);
    };

    return { ancestors: fetchOrdered(ancIds), descendants: fetchOrdered(descIds) };
  }

  /** Accumulate one turn's REAL usage + cost into a session (per-session, resettable). Missing
   *  fields contribute 0 (presence ≠ value — never invent). */
  addUsage(id: string, usage: TokenUsage, costUsd = 0): void {
    this.sqlite
      .query(
        `UPDATE sessions SET
           input_tokens       = input_tokens       + $in,
           output_tokens      = output_tokens      + $out,
           total_tokens       = total_tokens       + $total,
           cache_read_tokens  = cache_read_tokens  + $cr,
           cache_write_tokens = cache_write_tokens + $cw,
           reasoning_tokens   = reasoning_tokens   + $rt,
           cost_usd           = cost_usd           + $cost,
           updated_at         = $at
         WHERE id = $id`
      )
      .run({
        $in: usage.inputTokens ?? 0,
        $out: usage.outputTokens ?? 0,
        $total: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        $cr: usage.cacheReadTokens ?? 0,
        $cw: usage.cacheWriteTokens ?? 0,
        $rt: usage.reasoningTokens ?? 0,
        $cost: costUsd,
        $at: new Date().toISOString(),
        $id: id
      });
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
    this.db
      .insert(messages)
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
    const row = this.sqlite
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
    this.sqlite
      .query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id AND transcript_target_id = $target`)
      .run(binds);
    return true;
  }

  /** On daemon startup, terminally fail any rows left mid-stream by a crash/restart. Their turn is
   * dead and can never resume, so a client that sees `pending`/`streaming` would subscribe to a gone
   * stream and hang. Flipping them to `error` makes clients render from the row (terminal) instead;
   * excluding them from context keeps a half/empty turn out of later prompts. Returns the row count.
   * Safe because a freshly-started daemon has no live turns — every in-flight row is orphaned. */
  failOrphanedStreamingMessages(updatedAt: string): number {
    // Count via SELECT, not the UPDATE's `.changes`: the messages FTS triggers inflate the reported
    // change count, so it can't be trusted as a row count here.
    const n = (
      this.sqlite.query("SELECT COUNT(*) AS c FROM messages WHERE stream_status IN ('pending', 'streaming')").get() as {
        c: number;
      }
    ).c;
    if (n > 0) {
      this.sqlite
        .query(
          `UPDATE messages
           SET active = 0, stream_status = 'complete', include_in_context = 0, updated_at = $at
           WHERE stream_status IN ('pending', 'streaming')
             AND role = 'assistant'
             AND text = ''
             AND json_extract(data, '$.source') = 'managed-native-cli'`
        )
        .run({ $at: updatedAt });
      this.sqlite
        .query(
          "UPDATE messages SET stream_status = 'error', include_in_context = 0, updated_at = $at WHERE stream_status IN ('pending', 'streaming')"
        )
        .run({ $at: updatedAt });
    }
    return n;
  }

  /** Ordered by sqlite rowid (insertion order). Defaults to active (non-rewound) messages only. */
  listMessages(transcriptTargetId: string, opts: ListMessagesOptions = {}): ChatMessage[] {
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
    const rows = this.sqlite.query(q).all(binds) as Array<Record<string, unknown>>;
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
  listMessagesWithLineage(sessionId: string, opts: { includeInactive?: boolean; after?: string } = {}): ChatMessage[] {
    const self = this.getSession(sessionId);
    // `after` operates on the assembled lineage list (an id may live in an ancestor), so for a
    // root session we still slice here rather than delegating the cursor to listMessages.
    const sliceAfter = (msgs: ChatMessage[]): ChatMessage[] => {
      if (!opts.after) return msgs;
      const i = msgs.findIndex((m) => m.id === opts.after);
      return i === -1 ? msgs : msgs.slice(i + 1); // unknown cursor → everything (matches listMessages)
    };
    if (!self?.parentSessionId)
      return sliceAfter(this.listMessages(sessionId, { includeInactive: opts.includeInactive }));

    const chain = [...this.provenance(sessionId).ancestors, self];
    const out: ChatMessage[] = [];
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i] as Session;
      const child = chain[i + 1];
      let segment = this.listMessages(node.id, { includeInactive: opts.includeInactive });
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

  getMessage(transcriptTargetId: string, messageId: string): ChatMessage | null {
    const row = this.sqlite
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

  findManagedNativeCliStreamingMessage(
    transcriptTargetId: string,
    nativeCliSessionId: string,
    agentName: string
  ): string | null {
    const row = this.sqlite
      .query(
        `SELECT id FROM messages
         WHERE transcript_target_id = $target
           AND role = 'assistant'
           AND active = 1
           AND stream_status IN ('pending', 'streaming')
           AND json_extract(data, '$.source') = 'managed-native-cli'
           AND json_extract(data, '$.nativeCliSessionId') = $nativeCliSessionId
           AND json_extract(data, '$.agentName') = $agentName
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get({ $target: transcriptTargetId, $nativeCliSessionId: nativeCliSessionId, $agentName: agentName }) as {
      id: string;
    } | null;
    return row?.id ?? null;
  }

  retireManagedNativeCliStreamingMessage(
    transcriptTargetId: string,
    messageId: string,
    nativeCliSessionId: string,
    agentName: string,
    updatedAt = new Date().toISOString()
  ): boolean {
    const result = this.sqlite
      .query(
        `UPDATE messages
         SET active = 0, stream_status = 'complete', updated_at = $updatedAt
         WHERE id = $id
           AND transcript_target_id = $target
           AND role = 'assistant'
           AND active = 1
           AND stream_status IN ('pending', 'streaming')
           AND json_extract(data, '$.source') = 'managed-native-cli'
           AND json_extract(data, '$.nativeCliSessionId') = $nativeCliSessionId
           AND json_extract(data, '$.agentName') = $agentName`
      )
      .run({
        $updatedAt: updatedAt,
        $id: messageId,
        $target: transcriptTargetId,
        $nativeCliSessionId: nativeCliSessionId,
        $agentName: agentName
      });
    return result.changes === 1;
  }

  findRecentManagedNativeCliMessage(args: {
    transcriptTargetId: string;
    nativeCliSessionId: string;
    agentName: string;
    text: string;
    withinMs?: number;
  }): string | null {
    // Bounded window: this dedupes the same reply arriving twice around one turn settle
    // (provider final + explicit post). Without the bound, an agent legitimately posting
    // the same text again hours later would be silently swallowed.
    const since = new Date(Date.now() - (args.withinMs ?? 5 * 60_000)).toISOString();
    const row = this.sqlite
      .query(
        `SELECT id FROM messages
         WHERE transcript_target_id = $target
           AND role = 'assistant'
           AND active = 1
           AND text = $text
           AND created_at >= $since
           AND stream_status IN ('settled', 'complete')
           AND json_extract(data, '$.source') = 'managed-native-cli'
           AND json_extract(data, '$.nativeCliSessionId') = $nativeCliSessionId
           AND json_extract(data, '$.agentName') = $agentName
         ORDER BY rowid DESC
         LIMIT 1`
      )
      .get({
        $target: args.transcriptTargetId,
        $nativeCliSessionId: args.nativeCliSessionId,
        $agentName: args.agentName,
        $text: args.text,
        $since: since
      }) as { id: string } | null;
    return row?.id ?? null;
  }

  /** Global lookup of a LIVE message's text by id (no session needed). Used to trace a graph edge
   *  back to the source message it was extracted from (the bottom of the "why do you believe X"
   *  chain) — `active = 1` so a soft-deleted message can't resurface before the next reconcile. */
  getMessageText(messageId: string): string | null {
    const row = this.sqlite.query('SELECT text FROM messages WHERE id = ? AND active = 1').get(messageId) as {
      text: string;
    } | null;
    return row?.text ?? null;
  }

  /** Per-session durable key/value (the `memory` table). Returns null when unset. */
  getMemory(sessionId: string, key: string): string | null {
    const row = this.sqlite.query('SELECT value FROM memory WHERE session_id = ? AND key = ?').get(sessionId, key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  /** Upsert a per-session durable key/value. */
  setMemory(sessionId: string, key: string, value: string): void {
    this.sqlite
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
  restoreMessages(sessionId: string, toMessageId: string): { restoredCount: number; newHeadMessageId: string | null } {
    const at = new Date().toISOString();
    // `.changes` is inflated by the FTS sync triggers on UPDATE, so count explicitly.
    const tx = this.sqlite.transaction(() => {
      const summaryRow = this.sqlite
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
      const { n } = this.sqlite
        .query(
          `SELECT COUNT(*) AS n FROM messages
           WHERE transcript_target_id = $sid AND active = 1
             AND rowid >= (SELECT rowid FROM messages WHERE id = $mid)`
        )
        .get({ $sid: sessionId, $mid: toMessageId }) as { n: number };
      this.sqlite
        .query(
          `UPDATE messages SET active = 0, updated_at = $at
           WHERE transcript_target_id = $sid AND active = 1
             AND rowid >= (SELECT rowid FROM messages WHERE id = $mid)`
        )
        .run({ $at: at, $sid: sessionId, $mid: toMessageId });
      if (summaryBoundaryId) {
        const invalidated = this.sqlite
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
          this.sqlite.query("DELETE FROM memory WHERE session_id = $sid AND key = 'ctx:summary'").run({
            $sid: sessionId
          });
        }
      }
      this.sqlite
        .query('UPDATE sessions SET restore_count = restore_count + 1, updated_at = $at WHERE id = $id')
        .run({ $at: at, $id: sessionId });
      return n;
    });
    const restoredCount = tx();
    const head = this.sqlite
      .query('SELECT id FROM messages WHERE transcript_target_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1')
      .get(sessionId) as { id: string } | null;
    return { restoredCount, newHeadMessageId: head?.id ?? null };
  }

  /**
   * FTS5 (tokenized) + trigram (substring/CJK, queries ≥3 chars) + LIKE fallback.
   * `mode` semantic/hybrid degrade to keyword until embeddings are configured.
   */
  searchMessages(opts: SearchOptions): SearchHit[] {
    const q = opts.q.trim();
    if (!q) return [];
    const limit = opts.limit ?? 20;
    const transcriptTargetId = opts.transcriptTargetId;
    const hits = new Map<string, SearchHit>();

    const add = (r: SearchRow, score: number): void => {
      if (hits.has(r.id)) return;
      hits.set(r.id, {
        transcriptTargetId: r.transcript_target_id as SearchHit['transcriptTargetId'],
        transcriptTargetTitle: r.stitle,
        messageId: r.id as SearchHit['messageId'],
        role: r.role as SearchHit['role'],
        snippet: makeSnippet(r.text, q),
        at: r.created_at,
        score,
        matchedBy: 'keyword'
      });
    };

    const ftsMatch = `"${q.replace(/"/g, '""')}"`; // phrase query — neutralizes FTS5 operators
    const queryFts = (table: 'messages_fts' | 'messages_fts_trigram'): void => {
      const where = `${table} MATCH $q AND m.active = 1${transcriptTargetId ? ' AND m.transcript_target_id = $target' : ''}`;
      const rows = this.sqlite
        .query(
          `SELECT m.id, m.transcript_target_id, m.role, m.text, m.created_at, COALESCE(s.title, p.title) AS stitle, bm25(${table}) AS rank
           FROM ${table} f
           JOIN messages m ON m.rowid = f.rowid
           LEFT JOIN sessions s ON s.id = m.transcript_target_id
           LEFT JOIN workplace_projects p ON p.id = m.transcript_target_id
           WHERE ${where}
           ORDER BY rank LIMIT $lim`
        )
        .all(
          transcriptTargetId
            ? { $q: ftsMatch, $target: transcriptTargetId, $lim: limit }
            : { $q: ftsMatch, $lim: limit }
        ) as SearchRow[];
      for (const r of rows) add(r, -(r.rank ?? 0)); // bm25 returns negative scores; negate for ranking
    };

    try {
      queryFts('messages_fts');
      if (q.length >= 3) queryFts('messages_fts_trigram');
    } catch {
      // malformed FTS query (e.g. unbalanced quotes) — fall through to LIKE
    }

    if (hits.size === 0) {
      const rows = this.sqlite
        .query(
          `SELECT m.id, m.transcript_target_id, m.role, m.text, m.created_at, COALESCE(s.title, p.title) AS stitle
           FROM messages m
           LEFT JOIN sessions s ON s.id = m.transcript_target_id
           LEFT JOIN workplace_projects p ON p.id = m.transcript_target_id
           WHERE m.active = 1 AND m.text LIKE $like${transcriptTargetId ? ' AND m.transcript_target_id = $target' : ''}
           ORDER BY m.rowid DESC LIMIT $lim`
        )
        .all(
          transcriptTargetId
            ? { $like: `%${q}%`, $target: transcriptTargetId, $lim: limit }
            : { $like: `%${q}%`, $lim: limit }
        ) as SearchRow[];
      for (const r of rows) add(r, 0.1);
    }

    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Store/replace a message's embedding vector (raw little-endian float32 bytes). `model` records
   *  which embedding model produced it, so a later model switch can detect stale vectors. */
  upsertEmbedding(messageId: string, vec: number[], model?: string): void {
    this.sqlite
      .query('INSERT OR REPLACE INTO message_embeddings (message_id, dim, vec, model) VALUES (?, ?, ?, ?)')
      .run(messageId, vec.length, new Uint8Array(Float32Array.from(vec).buffer), model ?? null);
  }

  /** Drop every stored embedding (used when the embedding model changes and the user opts to
   *  re-index from scratch). Returns how many vectors were cleared; the indexer then rebuilds. */
  clearEmbeddings(): number {
    const n = (this.sqlite.query('SELECT COUNT(*) AS n FROM message_embeddings').get() as { n: number }).n;
    this.sqlite.query('DELETE FROM message_embeddings').run();
    return n;
  }

  /**
   * Active messages with no embedding yet. `limit` caps the batch — pass it for an unscoped
   * (whole-corpus) backfill so a single request can't materialize + embed the entire DB at
   * once; a session-scoped call is already bounded by that session and can omit it.
   */
  messagesMissingEmbedding(transcriptTargetId?: string, limit?: number): { id: string; text: string }[] {
    const where = transcriptTargetId ? 'AND m.transcript_target_id = ?' : '';
    const cap = limit && limit > 0 ? ' LIMIT ?' : '';
    const binds: (string | number)[] = transcriptTargetId ? [transcriptTargetId] : [];
    if (cap) binds.push(limit as number);
    const rows = this.sqlite
      .query(
        `SELECT m.id, m.text FROM messages m
         LEFT JOIN message_embeddings e ON e.message_id = m.id
         WHERE e.message_id IS NULL AND m.active = 1 AND m.text != '' ${where}${cap}`
      )
      .all(...binds) as { id: string; text: string }[];
    return rows;
  }

  /** How many active, non-empty messages still lack an embedding — surfaced as an "indexing N
   *  left" hint so a semantic search can tell the user recall may be incomplete. */
  pendingEmbeddingCount(transcriptTargetId?: string): number {
    const where = transcriptTargetId ? 'AND m.transcript_target_id = ?' : '';
    const binds = transcriptTargetId ? [transcriptTargetId] : [];
    const row = this.sqlite
      .query(
        `SELECT COUNT(*) AS n FROM messages m
         LEFT JOIN message_embeddings e ON e.message_id = m.id
         WHERE e.message_id IS NULL AND m.active = 1 AND m.text != '' ${where}`
      )
      .get(...binds) as { n: number };
    return row.n;
  }

  /** How many stored vectors were produced by a model OTHER than `currentModel` — i.e. stale after
   *  an embedding-model switch. Vectors with an unknown (NULL) model are not counted as stale. */
  staleEmbeddingCount(currentModel: string): number {
    const row = this.sqlite
      .query('SELECT COUNT(*) AS n FROM message_embeddings WHERE model IS NOT NULL AND model != ?')
      .get(currentModel) as { n: number };
    return row.n;
  }

  searchSemantic(
    queryVec: number[],
    opts: { limit?: number; transcriptTargetId?: TranscriptTargetId } = {}
  ): SearchHit[] {
    const limit = opts.limit ?? 20;
    // Precompute the query norm ONCE — cosine() used to recompute it for every row (N redundant
    // O(dim) passes). A zero/empty query can't match anything.
    let qNorm = 0;
    for (const x of queryVec) qNorm += x * x;
    qNorm = Math.sqrt(qNorm);
    if (qNorm === 0) return [];

    // Lean scan: pull only (id, vec) for active rows of the matching dimension — NOT each row's
    // text/title (transferring N message bodies just to drop all but `limit` is the dominant waste).
    // Still a linear scan: bun:sqlite can't load sqlite-vec, so there's no native ANN index to use.
    const where = opts.transcriptTargetId ? 'AND m.transcript_target_id = ?' : '';
    const rows = this.sqlite
      .query(
        `SELECT e.message_id AS id, e.vec AS vec
         FROM message_embeddings e
         JOIN messages m ON m.id = e.message_id
         WHERE e.dim = ? AND m.active = 1 ${where}`
      )
      .all(queryVec.length, ...(opts.transcriptTargetId ? [opts.transcriptTargetId] : [])) as {
      id: string;
      vec: Uint8Array;
    }[];

    const scored: { id: string; score: number }[] = [];
    for (const r of rows) {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
      if (v.length !== queryVec.length) continue;
      let dot = 0;
      let vn = 0;
      for (let i = 0; i < v.length; i++) {
        const y = v[i] as number;
        dot += (queryVec[i] as number) * y;
        vn += y * y;
      }
      if (vn === 0) continue;
      scored.push({ id: r.id, score: dot / (qNorm * Math.sqrt(vn)) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    if (top.length === 0) return [];

    // Now fetch display fields for just the winners (≤ limit rows).
    const placeholders = top.map(() => '?').join(',');
    const display = this.sqlite
      .query(
        `SELECT m.id, m.transcript_target_id, m.role, m.text, m.created_at, COALESCE(s.title, p.title) AS stitle
         FROM messages m
         LEFT JOIN sessions s ON s.id = m.transcript_target_id
         LEFT JOIN workplace_projects p ON p.id = m.transcript_target_id
         WHERE m.id IN (${placeholders})`
      )
      .all(...top.map((t) => t.id)) as SearchRow[];
    const byId = new Map(display.map((r) => [r.id, r]));

    return top.flatMap(({ id, score }) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          transcriptTargetId: r.transcript_target_id as SearchHit['transcriptTargetId'],
          transcriptTargetTitle: r.stitle,
          messageId: r.id as SearchHit['messageId'],
          role: r.role as SearchHit['role'],
          snippet: r.text.length > 80 ? `${r.text.slice(0, 80)}…` : r.text,
          at: r.created_at,
          score,
          matchedBy: 'semantic' as const
        }
      ];
    });
  }

  /** Idempotent on id (INSERT OR IGNORE). */
  appendEvents(batch: Event[]): void {
    if (batch.length === 0) return;
    const insert = this.sqlite.query(
      'INSERT OR IGNORE INTO events (id, transcript_target_id, type, actor_agent_id, task_id, payload, at) VALUES ($id, $transcriptTargetId, $type, $actorAgentId, $taskId, $payload, $at)'
    );
    const tx = this.sqlite.transaction((rows: Event[]) => {
      for (const e of rows) {
        insert.run({
          $id: e.id,
          $transcriptTargetId: e.transcriptTargetId,
          $type: e.type,
          $actorAgentId: e.actorAgentId,
          $taskId: e.taskId ?? null,
          $payload: JSON.stringify(e.payload),
          $at: e.at
        });
      }
    });
    tx(batch);
  }

  /** Find approval/clarify requests that have no matching resolved event (left dangling by a restart). */
  findDanglingInterrupts(): Array<{
    type: 'approval' | 'clarify';
    requestId: string;
    sessionId: string;
    tool?: string;
  }> {
    const approvals = this.sqlite
      .query(
        `SELECT transcript_target_id,
                json_extract(payload, '$.requestId') AS request_id,
                json_extract(payload, '$.tool')      AS tool
         FROM events
         WHERE type = 'tool.approval_requested'
           AND NOT EXISTS (
             SELECT 1 FROM events r
             WHERE r.type = 'tool.approval_resolved'
               AND r.transcript_target_id = events.transcript_target_id
               AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
           )`
      )
      .all() as Array<{ transcript_target_id: string; request_id: string | null; tool: string | null }>;
    const clarifies = this.sqlite
      .query(
        `SELECT transcript_target_id,
                json_extract(payload, '$.requestId') AS request_id
         FROM events
         WHERE type = 'clarify.requested'
           AND NOT EXISTS (
             SELECT 1 FROM events r
             WHERE r.type = 'clarify.resolved'
               AND r.transcript_target_id = events.transcript_target_id
               AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
           )`
      )
      .all() as Array<{ transcript_target_id: string; request_id: string | null }>;
    return [
      ...approvals
        .filter((r): r is typeof r & { request_id: string } => r.request_id !== null)
        .map((r) => ({
          type: 'approval' as const,
          requestId: r.request_id,
          sessionId: r.transcript_target_id,
          tool: r.tool ?? undefined
        })),
      ...clarifies
        .filter((r): r is typeof r & { request_id: string } => r.request_id !== null)
        .map((r) => ({ type: 'clarify' as const, requestId: r.request_id, sessionId: r.transcript_target_id }))
    ];
  }

  /** True when `eventId` is present in the durable event log. Lets callers distinguish a persisted
   *  cursor from an un-persisted live one (e.g. an `agent.token`) before calling {@link listEvents},
   *  whose missing-cursor fallback would otherwise replay the whole session. */
  hasEvent(eventId: string): boolean {
    return this.sqlite.query('SELECT 1 FROM events WHERE id = ? LIMIT 1').get(eventId) !== null;
  }

  /** Exclusive cursor; falls back to the whole session if `afterEventId` is not in the log. */
  listEvents(sessionId: string, afterEventId?: string): Event[] {
    const rows = this.sqlite
      .query(
        `SELECT id, transcript_target_id, type, actor_agent_id, task_id, payload, at
         FROM events
         WHERE transcript_target_id = $transcriptTargetId
           AND rowid > COALESCE((SELECT rowid FROM events WHERE id = $after), -1)
         ORDER BY rowid ASC`
      )
      .all({ $transcriptTargetId: sessionId, $after: afterEventId ?? null }) as Array<{
      id: string;
      transcript_target_id: string;
      type: string;
      actor_agent_id: string | null;
      task_id: string | null;
      payload: string;
      at: string;
    }>;
    return rows.map((r) => ({
      id: r.id as Event['id'],
      transcriptTargetId: r.transcript_target_id as Event['transcriptTargetId'],
      type: r.type as Event['type'],
      actorAgentId: r.actor_agent_id as Event['actorAgentId'],
      taskId: (r.task_id ?? undefined) as Event['taskId'],
      payload: JSON.parse(r.payload) as Event['payload'],
      at: r.at
    }));
  }

  getActiveConversation(channelId: string, conversationKey: string): ChannelConversation | null {
    const row = this.sqlite
      .query('SELECT * FROM channel_conversations WHERE channel_id = ? AND conversation_key = ?')
      .get(channelId, conversationKey) as Record<string, unknown> | null;
    return row ? rowToConversation(row) : null;
  }

  /** Repoint a conversation at `sessionId`, recording it in the history index. Upsert. */
  setActiveSession(args: {
    channelId: string;
    conversationKey: string;
    sessionId: string;
    principalId: string;
    label?: string;
  }): void {
    const now = new Date().toISOString();
    const tx = this.sqlite.transaction(() => {
      this.sqlite
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
      this.sqlite
        .query(
          `INSERT OR IGNORE INTO channel_conversation_sessions
             (channel_id, conversation_key, session_id, label, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(args.channelId, args.conversationKey, args.sessionId, args.label ?? null, now);
    });
    tx();
  }

  touchConversation(channelId: string, conversationKey: string): void {
    this.sqlite
      .query('UPDATE channel_conversations SET last_seen_at = ? WHERE channel_id = ? AND conversation_key = ?')
      .run(new Date().toISOString(), channelId, conversationKey);
  }

  listConversationSessions(channelId: string, conversationKey: string): ChannelConversationSession[] {
    const rows = this.sqlite
      .query(
        `SELECT session_id, label, created_at FROM channel_conversation_sessions
         WHERE channel_id = ? AND conversation_key = ? ORDER BY created_at ASC`
      )
      .all(channelId, conversationKey) as Array<{ session_id: string; label: string | null; created_at: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, label: r.label ?? undefined, createdAt: r.created_at }));
  }

  countActiveConversations(channelId: string): number {
    const row = this.sqlite
      .query('SELECT COUNT(*) AS n FROM channel_conversations WHERE channel_id = ?')
      .get(channelId) as { n: number };
    return row.n;
  }

  listActiveConversations(channelId: string): Array<{ conversationKey: string; activeSessionId: string }> {
    const rows = this.sqlite
      .query('SELECT conversation_key, active_session_id FROM channel_conversations WHERE channel_id = ?')
      .all(channelId) as Array<{ conversation_key: string; active_session_id: string }>;
    return rows.map((r) => ({ conversationKey: r.conversation_key, activeSessionId: r.active_session_id }));
  }

  createChannelModeratorRound(args: {
    id: string;
    channelId: string;
    moderatorKey: string;
    moderatorAgentId: string;
    originalInbound: ChannelInbound;
    depth: number;
    tasks: ChannelModeratorRoundTask[];
    deadlineAt: string;
  }): void {
    const now = new Date().toISOString();
    this.sqlite
      .query(
        `INSERT INTO channel_moderator_rounds
           (id, channel_id, moderator_key, moderator_agent_id, original_inbound, depth,
            tasks, results, status, deadline_at, created_at, updated_at)
         VALUES ($id, $channelId, $moderatorKey, $moderatorAgentId, $originalInbound, $depth,
                 $tasks, '[]', 'open', $deadlineAt, $now, $now)`
      )
      .run({
        $id: args.id,
        $channelId: args.channelId,
        $moderatorKey: args.moderatorKey,
        $moderatorAgentId: args.moderatorAgentId,
        $originalInbound: JSON.stringify(args.originalInbound),
        $depth: args.depth,
        $tasks: JSON.stringify(args.tasks),
        $deadlineAt: args.deadlineAt,
        $now: now
      });
  }

  updateChannelModeratorRoundResults(id: string, results: ChannelModeratorRoundResult[]): void {
    this.sqlite
      .query('UPDATE channel_moderator_rounds SET results = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(JSON.stringify(results), new Date().toISOString(), id, 'open');
  }

  settleChannelModeratorRound(id: string, results: ChannelModeratorRoundResult[]): void {
    this.sqlite
      .query(
        `UPDATE channel_moderator_rounds
         SET results = ?, status = 'settled', updated_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(results), new Date().toISOString(), id);
  }

  listOpenChannelModeratorRounds(channelId?: string): ChannelModeratorRoundRow[] {
    const rows = channelId
      ? (this.sqlite
          .query('SELECT * FROM channel_moderator_rounds WHERE status = ? AND channel_id = ? ORDER BY created_at ASC')
          .all('open', channelId) as Array<Record<string, unknown>>)
      : (this.sqlite
          .query('SELECT * FROM channel_moderator_rounds WHERE status = ? ORDER BY created_at ASC')
          .all('open') as Array<Record<string, unknown>>);
    return rows.map(rowToChannelModeratorRound);
  }

  // ── ACP Delegate Ledger ────────────────────────────────────────────────────────────────────────

  /** Insert a new live-delegate row on spawn. Upsert-safe: a re-spawn after eviction gets a fresh row. */
  upsertAcpDelegate(row: Omit<AcpDelegateRow, 'evictedAt' | 'evictReason' | 'reuseCount' | 'promptCount'>): void {
    this.sqlite
      .query(
        `INSERT INTO acp_delegates
           (id, session_id, agent_name, acp_session_id, pid, spawned_at, last_used_at,
            evicted_at, evict_reason, reuse_count, prompt_count)
         VALUES ($id, $sessionId, $agentName, $acpSessionId, $pid, $spawnedAt, $lastUsedAt,
                 NULL, NULL, 0, 0)
         ON CONFLICT(id) DO UPDATE SET
           acp_session_id = excluded.acp_session_id,
           pid            = excluded.pid,
           spawned_at     = excluded.spawned_at,
           last_used_at   = excluded.last_used_at,
           evicted_at     = NULL,
           evict_reason   = NULL,
           reuse_count    = 0,
           prompt_count   = 0`
      )
      .run({
        $id: row.id,
        $sessionId: row.sessionId,
        $agentName: row.agentName,
        $acpSessionId: row.acpSessionId,
        $pid: row.pid,
        $spawnedAt: row.spawnedAt,
        $lastUsedAt: row.lastUsedAt
      });
  }

  /** Update stats after a successful prompt (called in promptDelegate's finally block).
   *  Returns true if a live row was updated, false if the row was already evicted or missing. */
  touchAcpDelegate(id: string, lastUsedAt: string, reuseCount: number, promptCount: number): boolean {
    const result = this.sqlite
      .query(
        'UPDATE acp_delegates SET last_used_at=$at, reuse_count=$rc, prompt_count=$pc WHERE id=$id AND evicted_at IS NULL'
      )
      .run({ $at: lastUsedAt, $rc: reuseCount, $pc: promptCount, $id: id });
    return result.changes > 0;
  }

  /** Mark a delegate as evicted (either by explicit eviction or daemon restart cleanup). */
  closeAcpDelegate(id: string, evictedAt: string, reason: string): void {
    this.sqlite
      .query('UPDATE acp_delegates SET evicted_at=$at, evict_reason=$reason WHERE id=$id')
      .run({ $at: evictedAt, $reason: reason, $id: id });
  }

  /** All rows where evicted_at IS NULL — i.e. delegates that were live when the daemon last ran.
   *  Used at startup to detect and kill orphaned adapter processes. */
  listLiveAcpDelegates(): AcpDelegateRow[] {
    return (
      this.sqlite.query('SELECT * FROM acp_delegates WHERE evicted_at IS NULL ORDER BY spawned_at ASC').all() as Array<
        Record<string, unknown>
      >
    ).map(rowToAcpDelegate);
  }

  /** Recent delegate history for a session (live + evicted), newest first. */
  listAcpDelegatesForSession(sessionId: string, limit = 50): AcpDelegateRow[] {
    return (
      this.sqlite
        .query('SELECT * FROM acp_delegates WHERE session_id=? ORDER BY spawned_at DESC LIMIT ?')
        .all(sessionId, limit) as Array<Record<string, unknown>>
    ).map(rowToAcpDelegate);
  }

  /** Delete rows evicted more than `olderThanMs` milliseconds ago. Returns deleted count. */
  pruneOldAcpDelegates(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.sqlite.query('DELETE FROM acp_delegates WHERE evicted_at IS NOT NULL AND evicted_at < ?').run(cutoff)
      .changes;
  }

  /**
   * On daemon startup: close every delegate row that was live when the daemon last stopped (evicted_at
   * NULL), attempt to kill their adapter processes (best-effort — the PIDs may already be dead), and
   * mark them evicted. Returns how many rows were closed.
   *
   * Call ONCE, early, before any new delegates are spawned.
   */
  reconcileOrphanedDelegates(): number {
    const orphans = this.listLiveAcpDelegates();
    if (orphans.length === 0) return 0;
    const now = new Date().toISOString();
    for (const o of orphans) {
      if (o.pid > 0) {
        try {
          process.kill(o.pid, 'SIGTERM');
        } catch {
          // already dead — fine
        }
      }
      this.closeAcpDelegate(o.id, now, 'daemon_restart');
    }
    return orphans.length;
  }

  // ── Native CLI Session Ledger ─────────────────────────────────────────────────────────────────

  upsertNativeCliSession(row: NativeCliSessionRow): void {
    this.sqlite
      .query(
        `INSERT INTO native_cli_sessions
           (id, transcript_target_id, agent_name, provider, working_path, launch_mode, state,
            runtime_role, agent_runtime_id, agent_runtime_token_hash, last_delivered_seq, last_visible_seq, pid,
            provider_session_ref, output_snapshot, exit_code, started_at, updated_at, exited_at)
         VALUES ($id, $transcriptTargetId, $agentName, $provider, $workingPath, $launchMode, $state,
                 $runtimeRole, $agentRuntimeId, $agentRuntimeTokenHash, $lastDeliveredSeq, $lastVisibleSeq, $pid,
                 $providerSessionRef, $outputSnapshot, $exitCode, $startedAt, $updatedAt, $exitedAt)
         ON CONFLICT(id) DO UPDATE SET
           transcript_target_id = excluded.transcript_target_id,
           agent_name           = excluded.agent_name,
           provider             = excluded.provider,
           working_path         = excluded.working_path,
           launch_mode          = excluded.launch_mode,
           runtime_role         = excluded.runtime_role,
           agent_runtime_id     = excluded.agent_runtime_id,
           agent_runtime_token_hash = excluded.agent_runtime_token_hash,
           last_delivered_seq   = excluded.last_delivered_seq,
           last_visible_seq     = excluded.last_visible_seq,
           state                = excluded.state,
           pid                  = excluded.pid,
           provider_session_ref = excluded.provider_session_ref,
           output_snapshot      = excluded.output_snapshot,
           exit_code            = excluded.exit_code,
           updated_at           = excluded.updated_at,
           exited_at            = excluded.exited_at`
      )
      .run({
        $id: row.id,
        $transcriptTargetId: row.transcriptTargetId,
        $agentName: row.agentName,
        $provider: row.provider,
        $workingPath: row.workingPath,
        $launchMode: row.launchMode,
        $runtimeRole: row.runtimeRole ?? 'interactive',
        $agentRuntimeId: row.agentRuntimeId ?? null,
        $agentRuntimeTokenHash: row.agentRuntimeTokenHash ?? null,
        $lastDeliveredSeq: row.lastDeliveredSeq ?? 0,
        $lastVisibleSeq: row.lastVisibleSeq ?? 0,
        $state: row.state,
        $pid: row.pid,
        $providerSessionRef: row.providerSessionRef,
        $outputSnapshot: row.outputSnapshot,
        $exitCode: row.exitCode,
        $startedAt: row.startedAt,
        $updatedAt: row.updatedAt,
        $exitedAt: row.exitedAt
      });
  }

  getNativeCliSession(id: string): NativeCliSessionRow | null {
    const row = this.sqlite.query('SELECT * FROM native_cli_sessions WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null;
    return row ? rowToNativeCliSession(row) : null;
  }

  listNativeCliSessionsForTranscriptTarget(transcriptTargetId: string): NativeCliSessionRow[] {
    return (
      this.sqlite
        .query('SELECT * FROM native_cli_sessions WHERE transcript_target_id = ? ORDER BY started_at DESC')
        .all(transcriptTargetId) as Array<Record<string, unknown>>
    ).map(rowToNativeCliSession);
  }

  listLiveNativeCliSessions(): NativeCliSessionRow[] {
    return (
      this.sqlite
        .query("SELECT * FROM native_cli_sessions WHERE state IN ('starting', 'running') ORDER BY started_at ASC")
        .all() as Array<Record<string, unknown>>
    ).map(rowToNativeCliSession);
  }

  appendNativeCliOutput(id: string, chunk: string, maxSnapshotBytes = 256 * 1024): boolean {
    const current = this.getNativeCliSession(id);
    if (!current) return false;
    const next = `${current.outputSnapshot}${chunk}`;
    const outputSnapshot = next.length > maxSnapshotBytes ? next.slice(-maxSnapshotBytes) : next;
    return this.setNativeCliOutputSnapshot(id, outputSnapshot);
  }

  /** Overwrite the whole snapshot (no read-modify-write). The host buffers output in memory and
   *  flushes the bounded snapshot here on a timer, so the per-chunk path never touches SQLite. */
  setNativeCliOutputSnapshot(id: string, snapshot: string, maxSnapshotBytes = 256 * 1024): boolean {
    const bounded = snapshot.length > maxSnapshotBytes ? snapshot.slice(-maxSnapshotBytes) : snapshot;
    const result = this.sqlite
      .query('UPDATE native_cli_sessions SET output_snapshot = ?, updated_at = ? WHERE id = ?')
      .run(bounded, new Date().toISOString(), id);
    return result.changes > 0;
  }

  /** Delete terminal (exited/failed/stopped) sessions older than `olderThanMs`. Bounds table growth
   *  — one row per CLI launch, each carrying up to 256 KB of snapshot. Returns deleted count. */
  pruneExitedNativeCliSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.sqlite
      .query(
        "DELETE FROM native_cli_sessions WHERE state IN ('exited','failed','stopped') AND exited_at IS NOT NULL AND exited_at < ?"
      )
      .run(cutoff).changes;
  }

  updateNativeCliSessionRef(id: string, providerSessionRef: string): boolean {
    const result = this.sqlite
      .query('UPDATE native_cli_sessions SET provider_session_ref = ?, updated_at = ? WHERE id = ?')
      .run(providerSessionRef, new Date().toISOString(), id);
    return result.changes > 0;
  }

  clearNativeCliSessionRef(id: string): boolean {
    const result = this.sqlite
      .query('UPDATE native_cli_sessions SET provider_session_ref = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  setNativeCliVisibleCursor(id: string, seq: number): boolean {
    const result = this.sqlite
      .query(
        `UPDATE native_cli_sessions
         SET last_visible_seq = MAX(last_visible_seq, ?), updated_at = ?
         WHERE id = ?`
      )
      .run(seq, new Date().toISOString(), id);
    return result.changes > 0;
  }

  setNativeCliDeliveredCursor(id: string, seq: number): boolean {
    const result = this.sqlite
      .query(
        `UPDATE native_cli_sessions
         SET last_delivered_seq = MAX(last_delivered_seq, ?), updated_at = ?
         WHERE id = ?`
      )
      .run(seq, new Date().toISOString(), id);
    return result.changes > 0;
  }

  enqueueNativeCliInboxItem(
    nativeCliSessionId: string,
    messageSeq: number,
    createdAt = new Date().toISOString()
  ): boolean {
    const result = this.sqlite
      .query(
        `INSERT OR IGNORE INTO native_cli_inbox_items
           (native_cli_session_id, message_seq, state, created_at)
         VALUES (?, ?, 'queued', ?)`
      )
      .run(nativeCliSessionId, messageSeq, createdAt);
    return result.changes > 0;
  }

  markNativeCliInboxDelivered(nativeCliSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    const update = this.sqlite
      .query(
        `UPDATE native_cli_inbox_items
         SET state = CASE WHEN state = 'queued' THEN 'delivered' ELSE state END,
             delivered_at = COALESCE(delivered_at, ?)
         WHERE native_cli_session_id = ?
           AND message_seq <= ?
           AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, nativeCliSessionId, cursor);
    const cursorUpdated = this.setNativeCliDeliveredCursor(nativeCliSessionId, cursor);
    return update.changes > 0 || cursorUpdated;
  }

  markNativeCliInboxVisible(nativeCliSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    const update = this.sqlite
      .query(
        `UPDATE native_cli_inbox_items
         SET state = CASE WHEN state IN ('queued', 'delivered') THEN 'visible' ELSE state END,
             visible_at = COALESCE(visible_at, ?)
         WHERE native_cli_session_id = ?
           AND message_seq <= ?
           AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, nativeCliSessionId, cursor);
    const cursorUpdated = this.setNativeCliVisibleCursor(nativeCliSessionId, cursor);
    return update.changes > 0 || cursorUpdated;
  }

  markNativeCliInboxConsumed(nativeCliSessionId: string, cursor: number, at = new Date().toISOString()): boolean {
    const update = this.sqlite
      .query(
        `UPDATE native_cli_inbox_items
         SET state = 'consumed',
             consumed_at = COALESCE(consumed_at, ?)
         WHERE native_cli_session_id = ?
           AND message_seq <= ?
           AND state IN ('queued', 'delivered', 'visible')`
      )
      .run(at, nativeCliSessionId, cursor);
    const visibleUpdated = this.setNativeCliVisibleCursor(nativeCliSessionId, cursor);
    return update.changes > 0 || visibleUpdated;
  }

  hasUnconsumedNativeCliInbox(nativeCliSessionId: string, cursor?: number): boolean {
    const session = this.getNativeCliSession(nativeCliSessionId);
    if (!session) return false;
    const maxSeq = cursor ?? session.lastDeliveredSeq;
    if (maxSeq <= 0) return false;
    const row = this.sqlite
      .query(
        `SELECT 1 AS found
         FROM native_cli_inbox_items
         WHERE native_cli_session_id = ?
           AND message_seq <= ?
           AND state != 'consumed'
         LIMIT 1`
      )
      .get(nativeCliSessionId, maxSeq) as { found: number } | null;
    return !!row;
  }

  maxMessageSeq(sessionId: string): number {
    const row = this.sqlite
      .query('SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages WHERE transcript_target_id = ?')
      .get(sessionId) as { seq: number } | null;
    return row?.seq ?? 0;
  }

  maxMessageCreatedAt(sessionId: string): string | null {
    const row = this.sqlite
      .query('SELECT MAX(created_at) AS created_at FROM messages WHERE transcript_target_id = ?')
      .get(sessionId) as { created_at: string | null } | null;
    return row?.created_at ?? null;
  }

  listNativeCliInbox(nativeCliSessionId: string, limit = 50): NativeCliInboxItem[] {
    const session = this.getNativeCliSession(nativeCliSessionId);
    if (!session) return [];
    const rows = this.sqlite
      .query(
        `SELECT m.*, i.message_seq AS _native_cli_seq, i.state AS _native_cli_state
         FROM native_cli_inbox_items i
         JOIN messages m ON m.rowid = i.message_seq
         WHERE i.native_cli_session_id = ?
           AND i.message_seq > ?
           AND i.state != 'consumed'
           AND m.active = 1
         ORDER BY i.message_seq ASC
         LIMIT ?`
      )
      .all(nativeCliSessionId, session.lastVisibleSeq, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      seq: row._native_cli_seq as number,
      deliveryState: row._native_cli_state as NativeCliInboxDeliveryState,
      message: rowToMessage({
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
    }));
  }

  countNativeCliInbox(nativeCliSessionId: string): number {
    const session = this.getNativeCliSession(nativeCliSessionId);
    if (!session) return 0;
    const row = this.sqlite
      .query(
        `SELECT COUNT(*) AS count
         FROM native_cli_inbox_items i
         JOIN messages m ON m.rowid = i.message_seq
         WHERE i.native_cli_session_id = ?
           AND i.message_seq > ?
           AND i.state != 'consumed'
           AND m.active = 1`
      )
      .get(nativeCliSessionId, session.lastVisibleSeq) as { count: number } | null;
    return row?.count ?? 0;
  }

  insertNativeAgentDirectMessage(row: NativeAgentDirectMessage): void {
    this.sqlite
      .query(
        `INSERT INTO native_agent_direct_messages
          (id, project_id, native_cli_session_id, from_agent, peer, text, created_at)
         VALUES ($id, $projectId, $nativeCliSessionId, $fromAgent, $peer, $text, $createdAt)`
      )
      .run({
        $id: row.id,
        $projectId: row.projectId,
        $nativeCliSessionId: row.nativeCliSessionId,
        $fromAgent: row.fromAgent,
        $peer: row.peer,
        $text: row.text,
        $createdAt: row.createdAt
      });
  }

  listNativeAgentDirectMessages(
    nativeCliSessionId: string,
    peer: string,
    opts: { before?: string; after?: string; limit?: number } = {}
  ): NativeAgentDirectMessage[] {
    const session = this.getNativeCliSession(nativeCliSessionId);
    if (!session) return [];
    const binds: Record<string, string | number> = {
      $nativeCliSessionId: nativeCliSessionId,
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
    const rows = this.sqlite.query(query).all(binds) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as NativeAgentDirectMessage['id'],
      projectId: row.project_id as NativeAgentDirectMessage['projectId'],
      nativeCliSessionId: row.native_cli_session_id as string,
      fromAgent: (row.from_agent as string | null) ?? null,
      peer: row.peer as string,
      text: row.text as string,
      createdAt: row.created_at as string
    }));
  }

  closeNativeCliSession(
    id: string,
    exitedAt: string,
    exitCode: number | null,
    state: 'exited' | 'failed' | 'stopped' = 'exited'
  ): boolean {
    const result = this.sqlite
      .query(
        `UPDATE native_cli_sessions
         SET state = ?, exit_code = ?, exited_at = ?, updated_at = ?
         WHERE id = ?
           AND state IN ('starting', 'running')`
      )
      .run(state, exitCode, exitedAt, exitedAt, id);
    return result.changes > 0;
  }

  reconcileOrphanedNativeCliSessions(killPid: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM')): number {
    const orphans = this.listLiveNativeCliSessions();
    if (orphans.length === 0) return 0;
    const now = new Date().toISOString();
    for (const orphan of orphans) {
      if (orphan.pid !== null && orphan.pid > 0) {
        try {
          killPid(orphan.pid);
        } catch {
          // already dead
        }
      }
      this.closeNativeCliSession(orphan.id, now, null, 'stopped');
    }
    return orphans.length;
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
