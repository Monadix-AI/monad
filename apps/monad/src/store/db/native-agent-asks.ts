import type { Database } from 'bun:sqlite';

export type NativeAgentAskState =
  | 'waiting_sync'
  | 'detached_sync'
  | 'awaiting_human'
  | 'releasing'
  | 'recovering'
  | 'recovered';
type NativeAgentAskOutcome = 'answered' | 'skipped' | 'timed_out' | 'cancelled';
type NativeAgentAskAnswer = string | string[];

interface NativeAgentAskQuestion {
  id: string;
  question: string;
  options: string[];
  mode: 'single' | 'multiple';
  allowOther: boolean;
}

export interface CreateNativeAgentAskInput {
  requestId: string;
  projectId: string;
  projectSessionId: string;
  memberInstanceId: string;
  meshSessionId?: string;
  blocking: boolean;
  questions: NativeAgentAskQuestion[];
  expiresAt?: string;
  createdAt?: string;
}

export interface NativeAgentAskRecord {
  requestId: string;
  projectId: string;
  projectSessionId: string;
  memberInstanceId: string;
  meshSessionId?: string;
  blocking: boolean;
  state: NativeAgentAskState;
  questions: NativeAgentAskQuestion[];
  outcome?: NativeAgentAskOutcome;
  answers?: Record<string, NativeAgentAskAnswer>;
  expiresAt?: string;
  createdAt: string;
  resolvedAt?: string;
  updatedAt: string;
}

export interface NativeAgentMemberGate {
  projectId: string;
  projectSessionId: string;
  memberInstanceId: string;
  requestId: string;
  state: NativeAgentAskState;
  createdAt: string;
  updatedAt: string;
}

interface AskRow {
  request_id: string;
  project_id: string;
  project_session_id: string;
  member_instance_id: string;
  mesh_session_id: string | null;
  blocking: number;
  state: NativeAgentAskState;
  outcome: NativeAgentAskOutcome | null;
  answers: string | null;
  expires_at: string | null;
  created_at: string;
  resolved_at: string | null;
  updated_at: string;
}

interface QuestionRow {
  question_id: string;
  question: string;
  options: string;
  mode: 'single' | 'multiple';
  allow_other: number;
}

function readQuestions(sqlite: Database, requestId: string): NativeAgentAskQuestion[] {
  const rows = sqlite
    .query(
      `SELECT question_id, question, options, mode, allow_other
       FROM native_agent_ask_questions WHERE request_id = ? ORDER BY position`
    )
    .all(requestId) as QuestionRow[];
  return rows.map((row) => ({
    id: row.question_id,
    question: row.question,
    options: JSON.parse(row.options) as string[],
    mode: row.mode,
    allowOther: row.allow_other === 1
  }));
}

function rowToAsk(sqlite: Database, row: AskRow): NativeAgentAskRecord {
  return {
    requestId: row.request_id,
    projectId: row.project_id,
    projectSessionId: row.project_session_id,
    memberInstanceId: row.member_instance_id,
    ...(row.mesh_session_id === null ? {} : { meshSessionId: row.mesh_session_id }),
    blocking: row.blocking === 1,
    state: row.state,
    questions: readQuestions(sqlite, row.request_id),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.answers === null ? {} : { answers: JSON.parse(row.answers) as Record<string, NativeAgentAskAnswer> }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    updatedAt: row.updated_at
  };
}

export function getNativeAgentAsk(sqlite: Database, requestId: string): NativeAgentAskRecord | null {
  const row = sqlite.query('SELECT * FROM native_agent_asks WHERE request_id = ?').get(requestId) as AskRow | null;
  return row ? rowToAsk(sqlite, row) : null;
}

export function getNativeAgentMemberGate(
  sqlite: Database,
  projectSessionId: string,
  memberInstanceId: string
): NativeAgentMemberGate | null {
  const row = sqlite
    .query(
      `SELECT project_id, project_session_id, member_instance_id, request_id, state, created_at, updated_at
       FROM native_agent_member_gates WHERE project_session_id = ? AND member_instance_id = ?`
    )
    .get(projectSessionId, memberInstanceId) as {
    project_id: string;
    project_session_id: string;
    member_instance_id: string;
    request_id: string;
    state: NativeAgentAskState;
    created_at: string;
    updated_at: string;
  } | null;
  if (!row) return null;
  return {
    projectId: row.project_id,
    projectSessionId: row.project_session_id,
    memberInstanceId: row.member_instance_id,
    requestId: row.request_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createNativeAgentAsk(sqlite: Database, input: CreateNativeAgentAskInput): NativeAgentAskRecord {
  return sqlite.transaction(() => {
    const existing = sqlite
      .query(
        `SELECT request_id FROM native_agent_asks
         WHERE project_session_id = ? AND member_instance_id = ? AND resolved_at IS NULL`
      )
      .get(input.projectSessionId, input.memberInstanceId) as { request_id: string } | null;
    if (existing) throw new Error(`Member ${input.memberInstanceId} already has an unresolved project ask`);

    const at = input.createdAt ?? new Date().toISOString();
    const state: NativeAgentAskState = input.blocking ? 'awaiting_human' : 'waiting_sync';
    sqlite
      .query(
        `INSERT INTO native_agent_asks
           (request_id, project_id, project_session_id, member_instance_id, mesh_session_id, blocking,
            state, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.requestId,
        input.projectId,
        input.projectSessionId,
        input.memberInstanceId,
        input.meshSessionId ?? null,
        input.blocking ? 1 : 0,
        state,
        input.expiresAt ?? null,
        at,
        at
      );
    const insertQuestion = sqlite.query(
      `INSERT INTO native_agent_ask_questions
         (request_id, question_id, position, question, options, mode, allow_other)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    input.questions.forEach((question, position) => {
      insertQuestion.run(
        input.requestId,
        question.id,
        position,
        question.question,
        JSON.stringify(question.options),
        question.mode,
        question.allowOther ? 1 : 0
      );
    });
    sqlite
      .query(
        `INSERT INTO native_agent_member_gates
           (project_id, project_session_id, member_instance_id, request_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.projectId, input.projectSessionId, input.memberInstanceId, input.requestId, state, at, at);
    const ask = getNativeAgentAsk(sqlite, input.requestId);
    if (!ask) throw new Error(`Failed to persist native-agent ask ${input.requestId}`);
    return ask;
  })();
}

export interface SettleNativeAgentAskInput {
  requestId: string;
  outcome: NativeAgentAskOutcome;
  answers?: Record<string, NativeAgentAskAnswer>;
  at?: string;
}

type NativeAgentAskCancellationCause = 'timeout' | 'cancelled' | 'transport_eof';
export type NativeAgentAskCancellationStatus = NativeAgentAskOutcome | 'detached_sync';

export interface CancelNativeAgentAskInput {
  requestId: string;
  projectId: string;
  memberInstanceId: string;
  cause: NativeAgentAskCancellationCause;
  at?: string;
}

export function cancelNativeAgentAsk(
  sqlite: Database,
  input: CancelNativeAgentAskInput
): NativeAgentAskCancellationStatus | null {
  return sqlite.transaction(() => {
    const ask = getNativeAgentAsk(sqlite, input.requestId);
    if (!ask || ask.projectId !== input.projectId || ask.memberInstanceId !== input.memberInstanceId) return null;
    if (ask.outcome) return ask.outcome;
    const at = input.at ?? new Date().toISOString();
    if (input.cause === 'transport_eof') {
      const detached = sqlite
        .query(
          "UPDATE native_agent_asks SET state = 'detached_sync', updated_at = ? WHERE request_id = ? AND state = 'waiting_sync' AND resolved_at IS NULL"
        )
        .run(at, input.requestId);
      if (detached.changes > 0) {
        sqlite
          .query(
            "UPDATE native_agent_member_gates SET state = 'detached_sync', updated_at = ? WHERE request_id = ? AND state = 'waiting_sync'"
          )
          .run(at, input.requestId);
        return 'detached_sync';
      }
      return getNativeAgentAsk(sqlite, input.requestId)?.state === 'detached_sync' ? 'detached_sync' : null;
    }
    const outcome = input.cause === 'timeout' ? 'timed_out' : 'cancelled';
    settleNativeAgentAsk(sqlite, { requestId: input.requestId, outcome, at });
    return getNativeAgentAsk(sqlite, input.requestId)?.outcome ?? null;
  })();
}

export function settleNativeAgentAsk(sqlite: Database, input: SettleNativeAgentAskInput): boolean {
  return sqlite.transaction(() => {
    const at = input.at ?? new Date().toISOString();
    const settled = sqlite
      .query(
        `UPDATE native_agent_asks
         SET state = 'releasing', outcome = ?, answers = ?, resolved_at = ?, updated_at = ?
         WHERE request_id = ? AND resolved_at IS NULL`
      )
      .run(input.outcome, input.answers === undefined ? null : JSON.stringify(input.answers), at, at, input.requestId);
    if (settled.changes === 0) return false;
    sqlite
      .query(
        `UPDATE native_agent_member_gates SET state = 'releasing', updated_at = ?
         WHERE request_id = ? AND state IN ('waiting_sync', 'detached_sync', 'awaiting_human')`
      )
      .run(at, input.requestId);
    return true;
  })();
}

export function transitionNativeAgentMemberGate(
  sqlite: Database,
  requestId: string,
  from: NativeAgentAskState,
  to: NativeAgentAskState,
  at = new Date().toISOString()
): boolean {
  return sqlite.transaction(() => {
    const gate = sqlite
      .query('UPDATE native_agent_member_gates SET state = ?, updated_at = ? WHERE request_id = ? AND state = ?')
      .run(to, at, requestId, from);
    if (gate.changes === 0) return false;
    sqlite
      .query('UPDATE native_agent_asks SET state = ?, updated_at = ? WHERE request_id = ? AND state = ?')
      .run(to, at, requestId, from);
    return true;
  })();
}

export function reconcileNativeAgentAsksAfterRestart(sqlite: Database, at = new Date().toISOString()): string[] {
  return sqlite.transaction(() => {
    const rows = sqlite
      .query(
        "SELECT request_id FROM native_agent_asks WHERE state = 'waiting_sync' AND resolved_at IS NULL ORDER BY created_at"
      )
      .all() as Array<{ request_id: string }>;
    const updateAsk = sqlite.query(
      "UPDATE native_agent_asks SET state = 'detached_sync', updated_at = ? WHERE request_id = ? AND state = 'waiting_sync'"
    );
    const updateGate = sqlite.query(
      "UPDATE native_agent_member_gates SET state = 'detached_sync', updated_at = ? WHERE request_id = ? AND state = 'waiting_sync'"
    );
    for (const row of rows) {
      updateAsk.run(at, row.request_id);
      updateGate.run(at, row.request_id);
    }
    const recoveryRows = sqlite
      .query(
        `SELECT a.request_id
         FROM native_agent_asks a
         JOIN native_agent_member_gates g ON g.request_id = a.request_id
         WHERE a.resolved_at IS NOT NULL
           AND a.outcome IS NOT NULL
           AND a.state = 'recovering'
           AND g.state = 'recovering'
           AND EXISTS (
             SELECT 1
             FROM native_agent_recovery_batches b
             WHERE b.ask_request_id = a.request_id AND b.state = 'consumed'
           )`
      )
      .all() as Array<{ request_id: string }>;
    const deleteRecoveryGate = sqlite.query(
      "DELETE FROM native_agent_member_gates WHERE request_id = ? AND state = 'recovering'"
    );
    const finishRecovery = sqlite.query(
      "UPDATE native_agent_asks SET state = 'recovered', updated_at = ? WHERE request_id = ? AND state = 'recovering'"
    );
    for (const row of recoveryRows) {
      deleteRecoveryGate.run(row.request_id);
      finishRecovery.run(at, row.request_id);
    }
    return rows.map((row) => row.request_id);
  })();
}

export function finishNativeAgentAskRecovery(
  sqlite: Database,
  requestId: string,
  at = new Date().toISOString()
): boolean {
  return sqlite.transaction(() => {
    const ask = sqlite
      .query('SELECT project_id, project_session_id, member_instance_id FROM native_agent_asks WHERE request_id = ?')
      .get(requestId) as { project_id: string; project_session_id: string; member_instance_id: string } | null;
    if (!ask) return false;
    const pending = sqlite
      .query(
        `SELECT 1
         FROM native_agent_ingress_items i
         LEFT JOIN messages m ON m.rowid = i.message_seq
         LEFT JOIN native_agent_direct_messages d ON d.id = i.direct_message_id
         WHERE i.project_id = ? AND i.member_instance_id = ?
           AND COALESCE(m.transcript_target_id, d.session_id) = ?
           AND i.state IN ('queued', 'delivered')
         LIMIT 1`
      )
      .get(ask.project_id, ask.member_instance_id, ask.project_session_id);
    if (pending) return false;
    const removed = sqlite
      .query("DELETE FROM native_agent_member_gates WHERE request_id = ? AND state = 'recovering'")
      .run(requestId);
    if (removed.changes === 0) return false;
    sqlite
      .query("UPDATE native_agent_asks SET state = 'recovered', updated_at = ? WHERE request_id = ?")
      .run(at, requestId);
    return true;
  })();
}
