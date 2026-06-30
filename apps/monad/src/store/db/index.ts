import type {
  ChannelInbound,
  ChannelResponseNextTarget,
  ChatMessage,
  Event,
  GetStatsResponse,
  LedgerCategory,
  MessageType,
  NativeCliLaunchMode,
  NativeCliProvider,
  NativeCliSessionState,
  SearchHit,
  SearchMode,
  Session,
  SessionId,
  SessionState,
  StatsRange,
  StreamStatus,
  Task,
  TaskState,
  TokenUsage
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
  type SearchRow,
  toIntFlag
} from './row-mappers.ts';
import { messages, sessions, tasks } from './schema.ts';
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
  projectSessionId: SessionId;
  agentName: string;
  provider: NativeCliProvider;
  workingPath: string;
  launchMode: NativeCliLaunchMode;
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
    projectSessionId: r.project_session_id as SessionId,
    agentName: r.agent_name as string,
    provider: r.provider as NativeCliProvider,
    workingPath: r.working_path as string,
    launchMode: r.launch_mode as NativeCliLaunchMode,
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
  sessionId?: string;
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
      // WAL files) does not block the daemon's main event loop mid-request.
      this.#checkpointWorker = new Worker(new URL('./workers/wal-checkpoint.ts', import.meta.url));
      const dbPath = opts.path;
      this.#checkpointTimer = setInterval(
        () => {
          this.#checkpointWorker?.postMessage({ type: 'checkpoint', path: dbPath });
        },
        5 * 60 * 1000
      );
      this.#checkpointTimer.unref();
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
    // Most-recently-active first (updatedAt is bumped on every turn); id breaks ties so the
    // order is stable when several sessions share a timestamp.
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
        .query('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)')
        .run(sid);
      this.sqlite.query('DELETE FROM messages WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM events WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM acp_delegates WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM native_cli_sessions WHERE project_session_id = ?').run(sid);
      return this.sqlite.query('DELETE FROM sessions WHERE id = ?').run(sid).changes;
    });
    return tx(id) > 0;
  }

  clearMessages(id: string): number {
    const tx = this.sqlite.transaction((sid: string) => {
      // Count BEFORE deleting: the messages table has AFTER-DELETE FTS triggers, and bun:sqlite's
      // `result.changes` includes trigger-affected rows — so a DELETE's `.changes` over-counts. A
      // direct COUNT(*) is the only reliable "how many messages did we clear" (drives /reset's reply).
      const row = this.sqlite.query('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sid) as {
        n: number;
      };
      this.sqlite
        .query('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)')
        .run(sid);
      this.sqlite.query('DELETE FROM messages WHERE session_id = ?').run(sid);
      this.sqlite.query('DELETE FROM events WHERE session_id = ?').run(sid);
      this.sqlite.query("DELETE FROM memory WHERE session_id = ? AND key = 'ctx:summary'").run(sid);
      this.db.update(sessions).set({ updatedAt: new Date().toISOString() }).where(eq(sessions.id, sid)).run();
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
    sessionId: string,
    text: string,
    createdAt: string,
    role: ChatMessage['role'] = 'user',
    opts: { type?: MessageType; data?: unknown; streamStatus?: StreamStatus; includeInContext?: boolean } = {}
  ): void {
    this.db
      .insert(messages)
      .values({
        id,
        sessionId,
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
    sessionId: string,
    messageId: string,
    next: StreamStatus,
    updatedAt: string,
    content?: { text?: string; data?: unknown; type?: MessageType }
  ): boolean {
    const row = this.sqlite
      .query('SELECT stream_status FROM messages WHERE id = ? AND session_id = ?')
      .get(messageId, sessionId) as { stream_status: string } | null;
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
      $sid: sessionId
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
    this.sqlite.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id AND session_id = $sid`).run(binds);
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
          "UPDATE messages SET stream_status = 'error', include_in_context = 0, updated_at = $at WHERE stream_status IN ('pending', 'streaming')"
        )
        .run({ $at: updatedAt });
    }
    return n;
  }

  /** Ordered by sqlite rowid (insertion order). Defaults to active (non-rewound) messages only. */
  listMessages(sessionId: string, opts: ListMessagesOptions = {}): ChatMessage[] {
    const binds: Record<string, string | number> = { $sid: sessionId };
    const active = opts.includeInactive ? '' : ' AND active = 1';
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
        `SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE session_id = $sid${active}` +
        ' AND rowid <= COALESCE((SELECT rowid FROM messages WHERE id = $around), 9.2e18)' +
        ' ORDER BY rowid DESC LIMIT $upper)' +
        ` UNION ALL SELECT * FROM (SELECT *, rowid AS _rid FROM messages WHERE session_id = $sid${active}` +
        ' AND rowid > COALESCE((SELECT rowid FROM messages WHERE id = $around), 9.2e18)' +
        ' ORDER BY rowid ASC LIMIT $lower)' +
        ' ORDER BY _rid ASC';
    } else {
      const clauses = ['session_id = $sid'];
      if (!opts.includeInactive) clauses.push('active = 1');
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
        sessionId: r.session_id as string,
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

  getMessage(sessionId: string, messageId: string): ChatMessage | null {
    const row = this.sqlite
      .query('SELECT * FROM messages WHERE id = ? AND session_id = ?')
      .get(messageId, sessionId) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToMessage({
      id: row.id as string,
      sessionId: row.session_id as string,
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
           WHERE session_id = $sid AND active = 1
             AND rowid >= (SELECT rowid FROM messages WHERE id = $mid)`
        )
        .get({ $sid: sessionId, $mid: toMessageId }) as { n: number };
      this.sqlite
        .query(
          `UPDATE messages SET active = 0, updated_at = $at
           WHERE session_id = $sid AND active = 1
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
               AND target.session_id = $sid
               AND boundary.session_id = $sid
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
      .query('SELECT id FROM messages WHERE session_id = ? AND active = 1 ORDER BY rowid DESC LIMIT 1')
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
    const sid = opts.sessionId;
    const hits = new Map<string, SearchHit>();

    const add = (r: SearchRow, score: number): void => {
      if (hits.has(r.id)) return;
      hits.set(r.id, {
        sessionId: r.session_id as SearchHit['sessionId'],
        sessionTitle: r.stitle,
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
      const where = `${table} MATCH $q AND m.active = 1${sid ? ' AND m.session_id = $sid' : ''}`;
      const rows = this.sqlite
        .query(
          `SELECT m.id, m.session_id, m.role, m.text, m.created_at, s.title AS stitle, bm25(${table}) AS rank
           FROM ${table} f
           JOIN messages m ON m.rowid = f.rowid
           JOIN sessions s ON s.id = m.session_id
           WHERE ${where}
           ORDER BY rank LIMIT $lim`
        )
        .all(sid ? { $q: ftsMatch, $sid: sid, $lim: limit } : { $q: ftsMatch, $lim: limit }) as SearchRow[];
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
          `SELECT m.id, m.session_id, m.role, m.text, m.created_at, s.title AS stitle
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
           WHERE m.active = 1 AND m.text LIKE $like${sid ? ' AND m.session_id = $sid' : ''}
           ORDER BY m.rowid DESC LIMIT $lim`
        )
        .all(sid ? { $like: `%${q}%`, $sid: sid, $lim: limit } : { $like: `%${q}%`, $lim: limit }) as SearchRow[];
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
  messagesMissingEmbedding(sessionId?: string, limit?: number): { id: string; text: string }[] {
    const where = sessionId ? 'AND m.session_id = ?' : '';
    const cap = limit && limit > 0 ? ' LIMIT ?' : '';
    const binds: (string | number)[] = sessionId ? [sessionId] : [];
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
  pendingEmbeddingCount(sessionId?: string): number {
    const where = sessionId ? 'AND m.session_id = ?' : '';
    const binds = sessionId ? [sessionId] : [];
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

  searchSemantic(queryVec: number[], opts: { limit?: number; sessionId?: string } = {}): SearchHit[] {
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
    const where = opts.sessionId ? 'AND m.session_id = ?' : '';
    const rows = this.sqlite
      .query(
        `SELECT e.message_id AS id, e.vec AS vec
         FROM message_embeddings e
         JOIN messages m ON m.id = e.message_id
         WHERE e.dim = ? AND m.active = 1 ${where}`
      )
      .all(queryVec.length, ...(opts.sessionId ? [opts.sessionId] : [])) as { id: string; vec: Uint8Array }[];

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
        `SELECT m.id, m.session_id, m.role, m.text, m.created_at, s.title AS stitle
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE m.id IN (${placeholders})`
      )
      .all(...top.map((t) => t.id)) as SearchRow[];
    const byId = new Map(display.map((r) => [r.id, r]));

    return top.flatMap(({ id, score }) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          sessionId: r.session_id as SearchHit['sessionId'],
          sessionTitle: r.stitle,
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
      'INSERT OR IGNORE INTO events (id, session_id, type, actor_agent_id, task_id, payload, at) VALUES ($id, $sessionId, $type, $actorAgentId, $taskId, $payload, $at)'
    );
    const tx = this.sqlite.transaction((rows: Event[]) => {
      for (const e of rows) {
        insert.run({
          $id: e.id,
          $sessionId: e.sessionId,
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
        `SELECT session_id,
                json_extract(payload, '$.requestId') AS request_id,
                json_extract(payload, '$.tool')      AS tool
         FROM events
         WHERE type = 'tool.approval_requested'
           AND NOT EXISTS (
             SELECT 1 FROM events r
             WHERE r.type = 'tool.approval_resolved'
               AND r.session_id = events.session_id
               AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
           )`
      )
      .all() as Array<{ session_id: string; request_id: string | null; tool: string | null }>;
    const clarifies = this.sqlite
      .query(
        `SELECT session_id,
                json_extract(payload, '$.requestId') AS request_id
         FROM events
         WHERE type = 'clarify.requested'
           AND NOT EXISTS (
             SELECT 1 FROM events r
             WHERE r.type = 'clarify.resolved'
               AND r.session_id = events.session_id
               AND json_extract(r.payload, '$.requestId') = json_extract(events.payload, '$.requestId')
           )`
      )
      .all() as Array<{ session_id: string; request_id: string | null }>;
    return [
      ...approvals
        .filter((r): r is typeof r & { request_id: string } => r.request_id !== null)
        .map((r) => ({
          type: 'approval' as const,
          requestId: r.request_id,
          sessionId: r.session_id,
          tool: r.tool ?? undefined
        })),
      ...clarifies
        .filter((r): r is typeof r & { request_id: string } => r.request_id !== null)
        .map((r) => ({ type: 'clarify' as const, requestId: r.request_id, sessionId: r.session_id }))
    ];
  }

  /** Exclusive cursor; falls back to the whole session if `afterEventId` is not in the log. */
  listEvents(sessionId: string, afterEventId?: string): Event[] {
    const rows = this.sqlite
      .query(
        `SELECT id, session_id, type, actor_agent_id, task_id, payload, at
         FROM events
         WHERE session_id = $sessionId
           AND rowid > COALESCE((SELECT rowid FROM events WHERE id = $after), -1)
         ORDER BY rowid ASC`
      )
      .all({ $sessionId: sessionId, $after: afterEventId ?? null }) as Array<{
      id: string;
      session_id: string;
      type: string;
      actor_agent_id: string | null;
      task_id: string | null;
      payload: string;
      at: string;
    }>;
    return rows.map((r) => ({
      id: r.id as Event['id'],
      sessionId: r.session_id as Event['sessionId'],
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
           (id, project_session_id, agent_name, provider, working_path, launch_mode, state,
            pid, provider_session_ref, output_snapshot, exit_code, started_at, updated_at, exited_at)
         VALUES ($id, $projectSessionId, $agentName, $provider, $workingPath, $launchMode, $state,
                 $pid, $providerSessionRef, $outputSnapshot, $exitCode, $startedAt, $updatedAt, $exitedAt)
         ON CONFLICT(id) DO UPDATE SET
           project_session_id   = excluded.project_session_id,
           agent_name           = excluded.agent_name,
           provider             = excluded.provider,
           working_path         = excluded.working_path,
           launch_mode          = excluded.launch_mode,
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
        $projectSessionId: row.projectSessionId,
        $agentName: row.agentName,
        $provider: row.provider,
        $workingPath: row.workingPath,
        $launchMode: row.launchMode,
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

  listNativeCliSessionsForProject(projectSessionId: string): NativeCliSessionRow[] {
    return (
      this.sqlite
        .query('SELECT * FROM native_cli_sessions WHERE project_session_id = ? ORDER BY started_at DESC')
        .all(projectSessionId) as Array<Record<string, unknown>>
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
