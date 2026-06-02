import type { Database } from 'bun:sqlite';

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '#/store/db/index.ts';
import { reconcileNativeAgentMemberKeys } from '#/store/db/native-agent-key-reconcile.ts';

const AT1 = '2026-07-25T00:00:00.000Z';
const AT2 = '2026-07-26T00:00:00.000Z';

function sqliteOf(store: ReturnType<typeof createStore>): Database {
  return (store as unknown as { sqlite: Database }).sqlite;
}

function insertSession(sqlite: Database, id: string, projectId: string): void {
  sqlite
    .query(
      `INSERT INTO sessions (id, project_id, title, state, created_at, activity_at, updated_at)
       VALUES (?, ?, 'title', 'active', ?, ?, ?)`
    )
    .run(id, projectId, AT1, AT1, AT1);
}

function insertMember(sqlite: Database, projectId: string, id: string): void {
  sqlite
    .query(
      `INSERT INTO project_members (project_id, id, profile_id, type, display_name, created_at, updated_at)
       VALUES (?, ?, 'prof', 'native', 'Member', ?, ?)`
    )
    .run(projectId, id, AT1, AT1);
}

function insertMeshSession(
  sqlite: Database,
  id: string,
  transcriptTargetId: string,
  agentName: string,
  projectMemberId: string | null
): void {
  sqlite
    .query(
      `INSERT INTO mesh_sessions
         (id, transcript_target_id, agent_name, provider, working_path, runtime_role, state, project_member_id, started_at, updated_at)
       VALUES (?, ?, ?, 'codex', '/tmp', 'interactive', 'live', ?, ?, ?)`
    )
    .run(id, transcriptTargetId, agentName, projectMemberId, AT1, AT1);
}

function insertCounter(sqlite: Database, projectId: string, member: string, nextSeq: number): void {
  sqlite
    .query(
      'INSERT INTO mesh_agent_ingress_counters (project_id, member_instance_id, next_seq, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run(projectId, member, nextSeq, AT1);
}

function insertIngress(
  sqlite: Database,
  input: {
    id: string;
    projectId: string;
    member: string;
    meshSessionId?: string | null;
    ingressSeq: number;
    messageId?: string | null;
    updatedAt?: string;
  }
): void {
  sqlite
    .query(
      `INSERT INTO native_agent_ingress_items
         (id, project_id, member_instance_id, mesh_session_id, ingress_seq, source_kind, message_id, delivery_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'project', ?, ?, 'queued', ?, ?)`
    )
    .run(
      input.id,
      input.projectId,
      input.member,
      input.meshSessionId ?? null,
      input.ingressSeq,
      input.messageId ?? null,
      `deliv_${input.id}`,
      AT1,
      input.updatedAt ?? AT1
    );
}

function insertAsk(
  sqlite: Database,
  input: {
    requestId: string;
    projectId: string;
    sessionId: string;
    member: string;
    meshSessionId?: string | null;
    resolvedAt?: string | null;
  }
): void {
  sqlite
    .query(
      `INSERT INTO native_agent_asks
         (request_id, project_id, project_session_id, member_instance_id, mesh_session_id, state, created_at, resolved_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(
      input.requestId,
      input.projectId,
      input.sessionId,
      input.member,
      input.meshSessionId ?? null,
      AT1,
      input.resolvedAt ?? null,
      AT1
    );
}

function insertGate(
  sqlite: Database,
  input: { projectId: string; sessionId: string; member: string; requestId: string }
): void {
  sqlite
    .query(
      `INSERT INTO native_agent_member_gates
         (project_id, project_session_id, member_instance_id, request_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(input.projectId, input.sessionId, input.member, input.requestId, AT1, AT1);
}

function insertRecovery(
  sqlite: Database,
  input: { id: string; projectId: string; member: string; askRequestId?: string | null; highWaterSeq: number }
): void {
  sqlite
    .query(
      `INSERT INTO native_agent_recovery_batches
         (id, project_id, member_instance_id, ask_request_id, high_water_seq, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)`
    )
    .run(input.id, input.projectId, input.member, input.askRequestId ?? null, input.highWaterSeq, AT1, AT1);
}

function insertInbox(
  sqlite: Database,
  input: { meshSessionId: string; messageSeq: number; projectId: string | null; member: string | null }
): void {
  sqlite
    .query(
      `INSERT INTO mesh_agent_inbox_items
         (mesh_session_id, message_seq, project_id, member_instance_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`
    )
    .run(input.meshSessionId, input.messageSeq, input.projectId, input.member, AT1, AT1);
}

function insertSessionMember(
  sqlite: Database,
  sessionId: string,
  memberId: string,
  opts: { name?: string; instanceId?: string; displayName?: string } = {}
): void {
  sqlite
    .query(
      `INSERT INTO session_members (session_id, member_id, template_id, type, mesh_session_id, data, created_at, updated_at)
       VALUES (?, ?, NULL, 'mesh-agent', NULL, ?, ?, ?)`
    )
    .run(
      sessionId,
      memberId,
      JSON.stringify({
        name: opts.name ?? memberId,
        ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
        ...(opts.displayName ? { displayName: opts.displayName } : {})
      }),
      AT1,
      AT1
    );
}

function insertBinding(
  sqlite: Database,
  sessionId: string,
  projectMemberId: string,
  lifecycle: 'active' | 'left' = 'active'
): void {
  sqlite
    .query(
      `INSERT INTO session_bindings
         (session_id, project_member_id, last_delivered_seq, last_visible_seq, current_native_runtime_session_id, lifecycle, last_health, created_at, updated_at)
       VALUES (?, ?, 0, 0, NULL, ?, NULL, ?, ?)`
    )
    .run(sessionId, projectMemberId, lifecycle, AT1, AT1);
}

function insertProjectMemberNamed(
  sqlite: Database,
  projectId: string,
  id: string,
  opts: { profileId?: string; displayName?: string; type?: 'mesh-agent' | 'acp' } = {}
): void {
  sqlite
    .query(
      `INSERT INTO project_members (project_id, id, profile_id, type, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(projectId, id, opts.profileId ?? 'prof', opts.type ?? 'mesh-agent', opts.displayName ?? 'Member', AT1, AT1);
}

function insertDirectMessage(
  sqlite: Database,
  input: { id: string; sessionId: string; meshSessionId: string; fromAgent: string | null; peer: string }
): void {
  sqlite
    .query(
      `INSERT INTO native_agent_direct_messages (id, session_id, mesh_session_id, from_agent, peer, text, attachment_ids, created_at)
       VALUES (?, ?, ?, ?, ?, 'body', NULL, ?)`
    )
    .run(input.id, input.sessionId, input.meshSessionId, input.fromAgent, input.peer, AT1);
}

function directRow(sqlite: Database, id: string): { from_agent: string | null; peer: string } {
  return sqlite.query('SELECT from_agent, peer FROM native_agent_direct_messages WHERE id = ?').get(id) as {
    from_agent: string | null;
    peer: string;
  };
}

test('alias unique-hit rewrites member_instance_id to the canonical projectMemberId across all six tables', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_recon0000001';
    const ses = 'ses_recon000001';
    const pmid = 'mem_builder00001';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, pmid);
    insertMeshSession(sqlite, 'mesh_recon00001', ses, 'builder', pmid);

    insertCounter(sqlite, prj, 'builder', 5);
    insertIngress(sqlite, {
      id: 'ing_recon00001',
      projectId: prj,
      member: 'builder',
      ingressSeq: 3,
      messageId: 'msgA'
    });
    insertAsk(sqlite, { requestId: 'req_recon00001', projectId: prj, sessionId: ses, member: 'builder' });
    insertGate(sqlite, { projectId: prj, sessionId: ses, member: 'builder', requestId: 'req_recon00001' });
    insertRecovery(sqlite, { id: 'rb_recon000001', projectId: prj, member: 'builder', highWaterSeq: 3 });
    insertInbox(sqlite, { meshSessionId: 'mesh_recon00001', messageSeq: 1, projectId: prj, member: 'builder' });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 6, failures: 0, cleared: 0 });

    const counter = sqlite
      .query('SELECT member_instance_id, next_seq FROM mesh_agent_ingress_counters WHERE project_id = ?')
      .all(prj) as Array<{ member_instance_id: string; next_seq: number }>;
    expect(counter).toEqual([{ member_instance_id: pmid, next_seq: 5 }]);

    const ingress = sqlite
      .query('SELECT member_instance_id, ingress_seq, updated_at FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_recon00001') as { member_instance_id: string; ingress_seq: number; updated_at: string };
    expect(ingress).toEqual({ member_instance_id: pmid, ingress_seq: 1, updated_at: AT1 });

    const ask = sqlite
      .query('SELECT member_instance_id FROM native_agent_asks WHERE request_id = ?')
      .get('req_recon00001') as { member_instance_id: string };
    expect(ask).toEqual({ member_instance_id: pmid });

    const gate = sqlite
      .query('SELECT member_instance_id, request_id FROM native_agent_member_gates WHERE project_session_id = ?')
      .get(ses) as { member_instance_id: string; request_id: string };
    expect(gate).toEqual({ member_instance_id: pmid, request_id: 'req_recon00001' });

    const recovery = sqlite
      .query('SELECT member_instance_id FROM native_agent_recovery_batches WHERE id = ?')
      .get('rb_recon000001') as { member_instance_id: string };
    expect(recovery).toEqual({ member_instance_id: pmid });

    const inbox = sqlite
      .query('SELECT member_instance_id FROM mesh_agent_inbox_items WHERE mesh_session_id = ? AND message_seq = ?')
      .get('mesh_recon00001', 1) as { member_instance_id: string };
    expect(inbox).toEqual({ member_instance_id: pmid });

    const failures = sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as { c: number };
    expect(failures.c).toBe(0);
  } finally {
    store.close();
  }
});

test('durable owner via mesh_session_id wins over an ambiguous alias', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_owner0000001';
    const sesA = 'ses_owner00001a';
    const sesB = 'ses_owner00001b';
    const owner = 'mem_owner0000001';
    const other = 'mem_other0000001';
    insertSession(sqlite, sesA, prj);
    insertSession(sqlite, sesB, prj);
    insertMember(sqlite, prj, owner);
    insertMember(sqlite, prj, other);
    insertMeshSession(sqlite, 'mesh_owner0001a', sesA, 'builder', owner);
    insertMeshSession(sqlite, 'mesh_owner0001b', sesB, 'builder', other);

    insertIngress(sqlite, {
      id: 'ing_owner00001',
      projectId: prj,
      member: 'builder',
      meshSessionId: 'mesh_owner0001a',
      ingressSeq: 1,
      messageId: 'msgB'
    });
    insertInbox(sqlite, { meshSessionId: 'mesh_owner0001a', messageSeq: 1, projectId: prj, member: 'builder' });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 2, failures: 0, cleared: 0 });

    const ingress = sqlite
      .query('SELECT member_instance_id FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_owner00001') as { member_instance_id: string };
    expect(ingress).toEqual({ member_instance_id: owner });

    const inbox = sqlite
      .query('SELECT member_instance_id FROM mesh_agent_inbox_items WHERE mesh_session_id = ? AND message_seq = ?')
      .get('mesh_owner0001a', 1) as { member_instance_id: string };
    expect(inbox).toEqual({ member_instance_id: owner });

    const failures = sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as { c: number };
    expect(failures.c).toBe(0);
  } finally {
    store.close();
  }
});

test('zero alias candidates records a no_match failure and leaves the row untouched', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_nomatch00001';
    const ses = 'ses_nomatch0001';
    insertSession(sqlite, ses, prj);

    insertIngress(sqlite, {
      id: 'ing_nomatch0001',
      projectId: prj,
      member: 'ghost',
      ingressSeq: 7,
      messageId: 'msgG',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    const row = sqlite
      .query('SELECT member_instance_id, ingress_seq, updated_at FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_nomatch0001') as { member_instance_id: string; ingress_seq: number; updated_at: string };
    expect(row).toEqual({ member_instance_id: 'ghost', ingress_seq: 7, updated_at: '2026-01-01T00:00:00.000Z' });

    const failure = sqlite
      .query(
        'SELECT source_table, legacy_member_key, candidate_count, reason FROM native_agent_reconcile_failures WHERE source_table = ?'
      )
      .get('native_agent_ingress_items') as {
      source_table: string;
      legacy_member_key: string;
      candidate_count: number;
      reason: string;
    };
    expect(failure).toEqual({
      source_table: 'native_agent_ingress_items',
      legacy_member_key: 'ghost',
      candidate_count: 0,
      reason: 'no_match'
    });
  } finally {
    store.close();
  }
});

test('two members sharing an alias records an ambiguous failure and leaves the row untouched', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_ambig0000001';
    const sesA = 'ses_ambig00001a';
    const sesB = 'ses_ambig00001b';
    insertSession(sqlite, sesA, prj);
    insertSession(sqlite, sesB, prj);
    insertMember(sqlite, prj, 'mem_ambig0000a1');
    insertMember(sqlite, prj, 'mem_ambig0000b1');
    insertMeshSession(sqlite, 'mesh_ambig0001a', sesA, 'shared', 'mem_ambig0000a1');
    insertMeshSession(sqlite, 'mesh_ambig0001b', sesB, 'shared', 'mem_ambig0000b1');

    insertIngress(sqlite, { id: 'ing_ambig00001', projectId: prj, member: 'shared', ingressSeq: 4, messageId: 'msgS' });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    const row = sqlite
      .query('SELECT member_instance_id, ingress_seq FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_ambig00001') as { member_instance_id: string; ingress_seq: number };
    expect(row).toEqual({ member_instance_id: 'shared', ingress_seq: 4 });

    const failure = sqlite
      .query('SELECT candidate_count, reason FROM native_agent_reconcile_failures WHERE source_table = ?')
      .get('native_agent_ingress_items') as { candidate_count: number; reason: string };
    expect(failure).toEqual({ candidate_count: 2, reason: 'ambiguous' });
  } finally {
    store.close();
  }
});

test('two aliases merging into one member resequence ingress rows contiguously and merge the counter', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_merge0000001';
    const ses = 'ses_merge000001';
    const target = 'mem_target000001';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, target);
    insertMeshSession(sqlite, 'mesh_merge0001a', ses, 'aliasA', target);
    insertMeshSession(sqlite, 'mesh_merge0001b', ses, 'aliasB', target);

    insertIngress(sqlite, { id: 'ing_canon00001', projectId: prj, member: target, ingressSeq: 10, messageId: 'm10' });
    insertIngress(sqlite, { id: 'ing_canon00002', projectId: prj, member: target, ingressSeq: 11, messageId: 'm11' });
    insertIngress(sqlite, { id: 'ing_aliasA0001', projectId: prj, member: 'aliasA', ingressSeq: 2, messageId: 'mA1' });
    insertIngress(sqlite, { id: 'ing_aliasA0002', projectId: prj, member: 'aliasA', ingressSeq: 5, messageId: 'm10' });
    insertIngress(sqlite, { id: 'ing_aliasB0001', projectId: prj, member: 'aliasB', ingressSeq: 1, messageId: 'mB1' });

    insertCounter(sqlite, prj, target, 8);
    insertCounter(sqlite, prj, 'aliasA', 6);
    insertCounter(sqlite, prj, 'aliasB', 3);

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 5, failures: 0, cleared: 0 });

    const rows = sqlite
      .query(
        'SELECT id, member_instance_id, ingress_seq, message_id FROM native_agent_ingress_items WHERE project_id = ? ORDER BY ingress_seq'
      )
      .all(prj) as Array<{ id: string; member_instance_id: string; ingress_seq: number; message_id: string }>;
    expect(rows).toEqual([
      { id: 'ing_canon00001', member_instance_id: target, ingress_seq: 10, message_id: 'm10' },
      { id: 'ing_canon00002', member_instance_id: target, ingress_seq: 11, message_id: 'm11' },
      { id: 'ing_aliasB0001', member_instance_id: target, ingress_seq: 12, message_id: 'mB1' },
      { id: 'ing_aliasA0001', member_instance_id: target, ingress_seq: 13, message_id: 'mA1' }
    ]);

    const dropped = sqlite
      .query('SELECT COUNT(*) AS c FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_aliasA0002') as {
      c: number;
    };
    expect(dropped.c).toBe(0);

    const counters = sqlite
      .query(
        'SELECT member_instance_id, next_seq FROM mesh_agent_ingress_counters WHERE project_id = ? ORDER BY member_instance_id'
      )
      .all(prj) as Array<{ member_instance_id: string; next_seq: number }>;
    expect(counters).toEqual([{ member_instance_id: target, next_seq: 14 }]);
  } finally {
    store.close();
  }
});

test('a second run over already-canonical state mutates nothing', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_idem0000001';
    const ses = 'ses_idem000001';
    const pmid = 'mem_idem0000001';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, pmid);
    insertMeshSession(sqlite, 'mesh_idem00001', ses, 'builder', pmid);

    insertCounter(sqlite, prj, 'builder', 5);
    insertIngress(sqlite, { id: 'ing_idem00001', projectId: prj, member: 'builder', ingressSeq: 3, messageId: 'msgA' });
    insertAsk(sqlite, { requestId: 'req_idem00001', projectId: prj, sessionId: ses, member: 'builder' });
    insertGate(sqlite, { projectId: prj, sessionId: ses, member: 'builder', requestId: 'req_idem00001' });
    insertRecovery(sqlite, { id: 'rb_idem000001', projectId: prj, member: 'builder', highWaterSeq: 3 });
    insertInbox(sqlite, { meshSessionId: 'mesh_idem00001', messageSeq: 1, projectId: prj, member: 'builder' });
    insertIngress(sqlite, { id: 'ing_idemghost1', projectId: prj, member: 'ghost', ingressSeq: 9, messageId: 'msgG' });

    const first = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(first).toEqual({ reconciled: 6, failures: 1, cleared: 0 });

    const snapshot = () => ({
      counters: sqlite.query('SELECT * FROM mesh_agent_ingress_counters ORDER BY member_instance_id').all(),
      ingress: sqlite.query('SELECT * FROM native_agent_ingress_items ORDER BY id').all(),
      asks: sqlite.query('SELECT * FROM native_agent_asks ORDER BY request_id').all(),
      gates: sqlite.query('SELECT * FROM native_agent_member_gates ORDER BY member_instance_id').all(),
      recovery: sqlite.query('SELECT * FROM native_agent_recovery_batches ORDER BY id').all(),
      inbox: sqlite.query('SELECT * FROM mesh_agent_inbox_items ORDER BY message_seq').all(),
      failures: sqlite.query('SELECT * FROM native_agent_reconcile_failures ORDER BY id').all()
    });
    const before = snapshot();

    const second = reconcileNativeAgentMemberKeys(sqlite, AT2);
    expect(second).toEqual({ reconciled: 0, failures: 0, cleared: 0 });
    expect(snapshot()).toEqual(before);
  } finally {
    store.close();
  }
});

test('a failure whose identity later resolves is migrated and its failure row deleted on re-run', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_late0000001';
    const ses = 'ses_late000001';
    const pmid = 'mem_late0000001';
    insertSession(sqlite, ses, prj);
    insertIngress(sqlite, { id: 'ing_late00001', projectId: prj, member: 'builder', ingressSeq: 4, messageId: 'msgL' });

    const first = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(first).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    const loggedFailure = sqlite
      .query('SELECT reason, candidate_count FROM native_agent_reconcile_failures WHERE source_table = ?')
      .get('native_agent_ingress_items') as { reason: string; candidate_count: number };
    expect(loggedFailure).toEqual({ reason: 'no_match', candidate_count: 0 });

    insertMember(sqlite, prj, pmid);
    insertMeshSession(sqlite, 'mesh_late00001', ses, 'builder', pmid);

    const second = reconcileNativeAgentMemberKeys(sqlite, AT2);
    expect(second).toEqual({ reconciled: 1, failures: 0, cleared: 1 });

    const row = sqlite
      .query('SELECT member_instance_id, ingress_seq, updated_at FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_late00001') as { member_instance_id: string; ingress_seq: number; updated_at: string };
    expect(row).toEqual({ member_instance_id: pmid, ingress_seq: 1, updated_at: AT2 });

    const remaining = sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as { c: number };
    expect(remaining.c).toBe(0);
  } finally {
    store.close();
  }
});

test('a mesh_session_id owned by another project cannot re-key a row and falls closed', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prjA = 'prj_xproj00001a';
    const prjB = 'prj_xproj00001b';
    const sesA = 'ses_xproj0001a';
    const sesB = 'ses_xproj0001b';
    const memB = 'mem_xprojb00001';
    insertSession(sqlite, sesA, prjA);
    insertSession(sqlite, sesB, prjB);
    insertMember(sqlite, prjB, memB);
    // The mesh session and its owning member both live in project B.
    insertMeshSession(sqlite, 'mesh_xprojb0001', sesB, 'builder', memB);
    // A project-A ingress row that points at project B's mesh session and shares the alias 'builder'.
    insertIngress(sqlite, {
      id: 'ing_xproj00001',
      projectId: prjA,
      member: 'builder',
      meshSessionId: 'mesh_xprojb0001',
      ingressSeq: 1,
      messageId: 'msgX'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // Row untouched — never re-keyed to memB, the foreign owner.
    const ingress = sqlite
      .query('SELECT member_instance_id FROM native_agent_ingress_items WHERE id = ?')
      .get('ing_xproj00001') as { member_instance_id: string };
    expect(ingress).toEqual({ member_instance_id: 'builder' });

    const failures = sqlite
      .query(
        'SELECT source_table, project_id, session_id, legacy_member_key, candidate_count, reason FROM native_agent_reconcile_failures'
      )
      .all() as Array<Record<string, unknown>>;
    expect(failures).toEqual([
      {
        source_table: 'native_agent_ingress_items',
        project_id: prjA,
        session_id: null,
        legacy_member_key: 'builder',
        candidate_count: 0,
        reason: 'no_match'
      }
    ]);
  } finally {
    store.close();
  }
});

test('a gate collision aligns to the reconciled ask by request_id instead of forking', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_gate000001';
    const ses = 'ses_gate00001';
    const pmid = 'mem_gate000001';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, pmid);
    // One member, two runtimes under distinct aliases, both stamped to the same pmid.
    insertMeshSession(sqlite, 'mesh_gatea0001', ses, 'aliasA', pmid);
    insertMeshSession(sqlite, 'mesh_gateb0001', ses, 'aliasB', pmid);
    // Two unresolved asks keyed by the two aliases; both collide on pmid.
    insertAsk(sqlite, { requestId: 'req_a00000001', projectId: prj, sessionId: ses, member: 'aliasA' });
    insertAsk(sqlite, { requestId: 'req_b00000001', projectId: prj, sessionId: ses, member: 'aliasB' });
    // Insert req_b's gate FIRST — the ordering that made the old collision handler keep the wrong request.
    insertGate(sqlite, { projectId: prj, sessionId: ses, member: 'aliasB', requestId: 'req_b00000001' });
    insertGate(sqlite, { projectId: prj, sessionId: ses, member: 'aliasA', requestId: 'req_a00000001' });

    reconcileNativeAgentMemberKeys(sqlite, AT1);

    // The ask reconciler deterministically keeps the smallest request_id (req_a) in the (session, pmid) slot.
    const canonicalAsk = sqlite
      .query(
        'SELECT request_id FROM native_agent_asks WHERE project_session_id = ? AND member_instance_id = ? AND resolved_at IS NULL'
      )
      .get(ses, pmid) as { request_id: string };
    expect(canonicalAsk).toEqual({ request_id: 'req_a00000001' });
    // req_b lost the merge and stays on its legacy alias.
    const askB = sqlite
      .query('SELECT member_instance_id FROM native_agent_asks WHERE request_id = ?')
      .get('req_b00000001') as { member_instance_id: string };
    expect(askB).toEqual({ member_instance_id: 'aliasB' });
    // The canonical gate carries req_a — matching the canonical ask, never the first-inserted req_b.
    const canonicalGate = sqlite
      .query('SELECT request_id FROM native_agent_member_gates WHERE project_session_id = ? AND member_instance_id = ?')
      .get(ses, pmid) as { request_id: string };
    expect(canonicalGate).toEqual({ request_id: 'req_a00000001' });
    // The losing gate is preserved (never silently deleted), still bound to req_b on its legacy alias.
    const loserGate = sqlite
      .query('SELECT request_id FROM native_agent_member_gates WHERE project_session_id = ? AND member_instance_id = ?')
      .get(ses, 'aliasB') as { request_id: string };
    expect(loserGate).toEqual({ request_id: 'req_b00000001' });
  } finally {
    store.close();
  }
});

test('reconcile failures are cleared on session delete and project delete, sibling scope intact', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_td0000001';
    const sesX = 'ses_td00001x';
    const sesY = 'ses_td00001y';
    sqlite
      .query(
        `INSERT INTO workplace_projects (id, title, state, archived, member_templates, sort_rank, created_at, updated_at)
         VALUES (?, 'p', 'active', 0, '[]', 0, ?, ?)`
      )
      .run(prj, AT1, AT1);
    insertSession(sqlite, sesX, prj);
    insertSession(sqlite, sesY, prj);
    const insertFailure = (id: string, sessionId: string | null): void => {
      sqlite
        .query(
          `INSERT INTO native_agent_reconcile_failures
             (id, source_table, project_id, session_id, legacy_member_key, candidate_count, reason, created_at, updated_at)
           VALUES (?, 'native_agent_asks', ?, ?, 'legacy', 0, 'no_match', ?, ?)`
        )
        .run(id, prj, sessionId, AT1, AT1);
    };
    insertFailure('f_sesX', sesX);
    insertFailure('f_sesY', sesY);
    insertFailure('f_proj', null);

    // Deleting one session removes only its session-scoped failure; the sibling and project-scoped rows stay.
    expect(store.deleteSession(sesX)).toBe(true);
    const afterSession = sqlite.query('SELECT id FROM native_agent_reconcile_failures ORDER BY id').all() as Array<{
      id: string;
    }>;
    expect(afterSession).toEqual([{ id: 'f_proj' }, { id: 'f_sesY' }]);

    // Deleting the project removes every remaining failure under it (session-scoped and project-scoped).
    expect(store.deleteWorkplaceProject(prj)).toBe(true);
    const afterProject = sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as {
      c: number;
    };
    expect(afterProject.c).toBe(0);
  } finally {
    store.close();
  }
});

test('a same-project ask whose mesh_session_id points at another session falls closed', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_xsess00001';
    const sesA = 'ses_xsess0001a';
    const sesB = 'ses_xsess0001b';
    const memB = 'mem_scope_b0001';
    insertSession(sqlite, sesA, prj);
    insertSession(sqlite, sesB, prj);
    insertMember(sqlite, prj, memB);
    // Session B's runtime, owned by memB, using an alias that never appears in session A.
    insertMeshSession(sqlite, 'mesh_xsessb0001', sesB, 'builder', memB);
    // Session A's unresolved ask wrongly references session B's mesh_session_id.
    insertAsk(sqlite, {
      requestId: 'req_xsess00001',
      projectId: prj,
      sessionId: sesA,
      member: 'builder',
      meshSessionId: 'mesh_xsessb0001'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // Ask kept on its alias — never re-keyed to session B's owner memB.
    const ask = sqlite
      .query('SELECT member_instance_id FROM native_agent_asks WHERE request_id = ?')
      .get('req_xsess00001') as { member_instance_id: string };
    expect(ask).toEqual({ member_instance_id: 'builder' });

    const failures = sqlite
      .query(
        'SELECT source_table, project_id, session_id, legacy_member_key, reason FROM native_agent_reconcile_failures'
      )
      .all() as Array<Record<string, unknown>>;
    expect(failures).toEqual([
      {
        source_table: 'native_agent_asks',
        project_id: prj,
        session_id: sesA,
        legacy_member_key: 'builder',
        reason: 'no_match'
      }
    ]);
  } finally {
    store.close();
  }
});

test('an ask whose project_id and project_session_id disagree on the project falls closed', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prjA = 'prj_corrupt001a';
    const prjB = 'prj_corrupt001b';
    const sesB = 'ses_corrupt01b';
    const memB = 'mem_corrupt0001';
    insertSession(sqlite, sesB, prjB);
    insertMember(sqlite, prjB, memB);
    insertMeshSession(sqlite, 'mesh_corrupt001', sesB, 'builder', memB);
    // Corrupted ask: claims project A, but its project_session_id is a session that belongs to project B.
    insertAsk(sqlite, { requestId: 'req_corrupt001', projectId: prjA, sessionId: sesB, member: 'builder' });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // The session belongs to project B, so project A's scope resolves no candidate — kept, not re-keyed.
    const ask = sqlite
      .query('SELECT member_instance_id FROM native_agent_asks WHERE request_id = ?')
      .get('req_corrupt001') as { member_instance_id: string };
    expect(ask).toEqual({ member_instance_id: 'builder' });

    const failure = sqlite
      .query('SELECT source_table, project_id, session_id, reason FROM native_agent_reconcile_failures')
      .all() as Array<Record<string, unknown>>;
    expect(failure).toEqual([
      { source_table: 'native_agent_asks', project_id: prjA, session_id: sesB, reason: 'no_match' }
    ]);
  } finally {
    store.close();
  }
});

test('direct message: sender re-keys to its owner while a non-member private label peer is kept verbatim', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000001';
    const ses = 'ses_dm0000001';
    const pmid = 'mem_dmsender01';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, pmid);
    insertMeshSession(sqlite, 'mesh_dm00000001', ses, 'builder', pmid);
    insertDirectMessage(sqlite, {
      id: 'dm_priv0000001',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000001',
      fromAgent: 'builder',
      peer: 'human:zeke'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 1, failures: 0, cleared: 0 });

    // Sender re-keyed to its canonical owner; the private-label peer is a legitimate non-member, kept raw.
    expect(directRow(sqlite, 'dm_priv0000001')).toEqual({ from_agent: pmid, peer: 'human:zeke' });
    expect((sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as { c: number }).c).toBe(
      0
    );
  } finally {
    store.close();
  }
});

test('direct message: peer re-keys to a unique member alias resolved from the offline session_members roster', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000002';
    const ses = 'ses_dm0000002';
    const sender = 'mem_sender0002';
    const helper = 'mem_helper0002';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, sender);
    insertMember(sqlite, prj, helper);
    insertMeshSession(sqlite, 'mesh_dm00000002', ses, 'builder', sender);
    // The peer has no live runtime — only a durable roster row (offline). Its alias must still resolve.
    insertSessionMember(sqlite, ses, helper, { instanceId: 'helper' });
    insertDirectMessage(sqlite, {
      id: 'dm_pair0000002',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000002',
      fromAgent: 'builder',
      peer: 'helper'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 1, failures: 0, cleared: 0 });
    expect(directRow(sqlite, 'dm_pair0000002')).toEqual({ from_agent: sender, peer: helper });
    expect((sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as { c: number }).c).toBe(
      0
    );
  } finally {
    store.close();
  }
});

test('direct message: an ambiguous peer alias fails closed and holds the whole row, leaving the sender unchanged', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000003';
    const ses = 'ses_dm0000003';
    const sender = 'mem_sender0003';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, sender);
    insertMember(sqlite, prj, 'mem_shareda003');
    insertMember(sqlite, prj, 'mem_sharedb003');
    insertMeshSession(sqlite, 'mesh_dm00000003', ses, 'builder', sender);
    // Two roster members share the alias 'shared' — the peer is genuinely ambiguous.
    insertSessionMember(sqlite, ses, 'mem_shareda003', { instanceId: 'shared' });
    insertSessionMember(sqlite, ses, 'mem_sharedb003', { instanceId: 'shared' });
    insertDirectMessage(sqlite, {
      id: 'dm_ambig000003',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000003',
      fromAgent: 'builder',
      peer: 'shared'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // Atomic pair: even though the sender resolves, the ambiguous peer holds the entire row on its old values.
    expect(directRow(sqlite, 'dm_ambig000003')).toEqual({ from_agent: 'builder', peer: 'shared' });
    const failures = sqlite
      .query('SELECT source_table, legacy_member_key, candidate_count, reason FROM native_agent_reconcile_failures')
      .all() as Array<Record<string, unknown>>;
    expect(failures).toEqual([
      {
        source_table: 'native_agent_direct_messages',
        legacy_member_key: 'shared',
        candidate_count: 2,
        reason: 'ambiguous'
      }
    ]);
  } finally {
    store.close();
  }
});

test('direct message: an unresolvable sender fails closed and holds the row, never applying the resolvable peer', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000004';
    const ses = 'ses_dm0000004';
    const helper = 'mem_helper0004';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, helper);
    // The sender's mesh session has no stamped owner and no alias match, so from_agent cannot resolve.
    insertMeshSession(sqlite, 'mesh_dm00000004', ses, 'ghostrt', null);
    insertSessionMember(sqlite, ses, helper, { instanceId: 'helper' });
    insertDirectMessage(sqlite, {
      id: 'dm_fromf00004',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000004',
      fromAgent: 'ghost',
      peer: 'helper'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // The resolvable peer is NOT applied — a failed sender holds the whole row (no canonical/alias hybrid).
    expect(directRow(sqlite, 'dm_fromf00004')).toEqual({ from_agent: 'ghost', peer: 'helper' });
    const failure = sqlite
      .query('SELECT source_table, legacy_member_key, reason FROM native_agent_reconcile_failures')
      .all() as Array<Record<string, unknown>>;
    expect(failure).toEqual([
      { source_table: 'native_agent_direct_messages', legacy_member_key: 'ghost', reason: 'no_match' }
    ]);
  } finally {
    store.close();
  }
});

test('direct message: a null sender is preserved as null while the peer re-keys, and is never a failure', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000005';
    const ses = 'ses_dm0000005';
    const helper = 'mem_helper0005';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, helper);
    insertMeshSession(sqlite, 'mesh_dm00000005', ses, 'builder', 'mem_owner0005');
    insertSessionMember(sqlite, ses, helper, { instanceId: 'helper' });
    insertDirectMessage(sqlite, {
      id: 'dm_null000005',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000005',
      fromAgent: null,
      peer: 'helper'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 1, failures: 0, cleared: 0 });
    expect(directRow(sqlite, 'dm_null000005')).toEqual({ from_agent: null, peer: helper });
    expect((sqlite.query('SELECT COUNT(*) AS c FROM native_agent_reconcile_failures').get() as { c: number }).c).toBe(
      0
    );
  } finally {
    store.close();
  }
});

test('direct message: pmem-shaped-but-unknown sender fails closed (no reliable pmid syntax to trust)', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000006';
    const ses = 'ses_dm0000006';
    insertSession(sqlite, ses, prj);
    insertMeshSession(sqlite, 'mesh_dm00000006', ses, 'ghostrt', null);
    insertDirectMessage(sqlite, {
      id: 'dm_fake000006',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000006',
      fromAgent: 'pmem_fake',
      peer: 'human:zeke'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // 'pmem_fake' is not a real ProjectMember, so the sender fails closed; the private-label peer is a noop.
    expect(directRow(sqlite, 'dm_fake000006')).toEqual({ from_agent: 'pmem_fake', peer: 'human:zeke' });
    const failure = sqlite
      .query('SELECT legacy_member_key, reason FROM native_agent_reconcile_failures')
      .all() as Array<Record<string, unknown>>;
    expect(failure).toEqual([{ legacy_member_key: 'pmem_fake', reason: 'no_match' }]);
  } finally {
    store.close();
  }
});

test('direct message: a second reconcile over converged rows mutates nothing (row + failure ledger byte-equal)', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm00000007';
    const ses = 'ses_dm0000007';
    const sender = 'mem_sender0007';
    const helper = 'mem_helper0007';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, sender);
    insertMember(sqlite, prj, helper);
    insertMeshSession(sqlite, 'mesh_dm00000007', ses, 'builder', sender);
    insertSessionMember(sqlite, ses, helper, { instanceId: 'helper' });
    insertDirectMessage(sqlite, {
      id: 'dm_conv000007',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000007',
      fromAgent: 'builder',
      peer: 'helper'
    });
    // A second row that permanently fails closed (unknown sender) so the ledger has a stable failure to compare.
    insertMeshSession(sqlite, 'mesh_dm000000g7', ses, 'ghostrt', null);
    insertDirectMessage(sqlite, {
      id: 'dm_stuck00007',
      sessionId: ses,
      meshSessionId: 'mesh_dm000000g7',
      fromAgent: 'ghost',
      peer: 'human:zeke'
    });

    const first = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(first).toEqual({ reconciled: 1, failures: 1, cleared: 0 });

    const snapshot = () => ({
      direct: sqlite.query('SELECT * FROM native_agent_direct_messages ORDER BY id').all(),
      failures: sqlite.query('SELECT * FROM native_agent_reconcile_failures ORDER BY id').all()
    });
    const before = snapshot();

    const second = reconcileNativeAgentMemberKeys(sqlite, AT2);
    expect(second).toEqual({ reconciled: 0, failures: 0, cleared: 0 });
    expect(snapshot()).toEqual(before);
  } finally {
    store.close();
  }
});

test('direct message: the authoritative mesh owner re-keys the sender even when from_agent is another member', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm0000000a1';
    const ses = 'ses_dm000000a1';
    const owner = 'mem_ownerA0001';
    const other = 'mem_otherB0001';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, owner);
    insertMember(sqlite, prj, other);
    // The runtime's mesh session is owned by A, but the row's from_agent claims B (also a real member).
    insertMeshSession(sqlite, 'mesh_dm0000000a1', ses, 'builder', owner);
    insertDirectMessage(sqlite, {
      id: 'dm_owner00000a1',
      sessionId: ses,
      meshSessionId: 'mesh_dm0000000a1',
      fromAgent: other,
      peer: 'human:zeke'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 1, failures: 0, cleared: 0 });

    // Authoritative owner wins: from_agent is corrected to A, never left on the claimed member B.
    expect(directRow(sqlite, 'dm_owner00000a1')).toEqual({ from_agent: owner, peer: 'human:zeke' });
  } finally {
    store.close();
  }
});

test('direct message: a same-project member not bound to the row session is not treated as canonical', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm0000000b1';
    const ses = 'ses_dm000000b1';
    const unbound = 'mem_unbound0001';
    insertSession(sqlite, ses, prj);
    // `unbound` is a real ProjectMember of the project but has NO SessionBinding in this session.
    insertMember(sqlite, prj, unbound);
    insertMeshSession(sqlite, 'mesh_dm0000000b1', ses, 'ghostrt', null);
    insertDirectMessage(sqlite, {
      id: 'dm_unbound00b1',
      sessionId: ses,
      meshSessionId: 'mesh_dm0000000b1',
      fromAgent: unbound,
      peer: 'human:zeke'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    // The unbound pmid is not a canonical member of this session, so the sender fails closed (not a noop).
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });
    expect(directRow(sqlite, 'dm_unbound00b1')).toEqual({ from_agent: unbound, peer: 'human:zeke' });
    const failure = sqlite
      .query('SELECT legacy_member_key, reason FROM native_agent_reconcile_failures')
      .all() as Array<Record<string, unknown>>;
    expect(failure).toEqual([{ legacy_member_key: unbound, reason: 'no_match' }]);
  } finally {
    store.close();
  }
});

test('direct message: a peer alias resolves through a canonical SessionBinding with no legacy row', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm0000000c1';
    const ses = 'ses_dm000000c1';
    const sender = 'mem_senderC0001';
    const helper = 'mem_helperC0001';
    insertSession(sqlite, ses, prj);
    insertMember(sqlite, prj, sender);
    insertMeshSession(sqlite, 'mesh_dm0000000c1', ses, 'builder', sender);
    // The peer exists ONLY as a canonical ProjectMember + SessionBinding (profile 'helper'), no legacy row.
    insertProjectMemberNamed(sqlite, prj, helper, { profileId: 'helper', displayName: 'Helper' });
    insertBinding(sqlite, ses, helper);
    insertDirectMessage(sqlite, {
      id: 'dm_bindpeerc1',
      sessionId: ses,
      meshSessionId: 'mesh_dm0000000c1',
      fromAgent: 'builder',
      peer: 'helper'
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 1, failures: 0, cleared: 0 });
    // Peer alias 'helper' resolves to the bound member's pmid via the canonical roster, not session_members.
    expect(directRow(sqlite, 'dm_bindpeerc1')).toEqual({ from_agent: sender, peer: helper });
  } finally {
    store.close();
  }
});

test('direct message: a bound ACP member id is not a canonical direct member (mesh-agent only)', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const prj = 'prj_dm0000000d1';
    const ses = 'ses_dm000000d1';
    const acp = 'mem_acpmemb0001';
    insertSession(sqlite, ses, prj);
    // A real, bound member of the session — but type 'acp', which direct messaging must not treat as canonical.
    insertProjectMemberNamed(sqlite, prj, acp, { type: 'acp', displayName: 'Editor' });
    insertBinding(sqlite, ses, acp);
    insertMeshSession(sqlite, 'mesh_dm0000000d1', ses, 'ghostrt', null);
    // Sender is the ACP id with no authoritative mesh owner → must fail closed, not be treated as canonical.
    insertDirectMessage(sqlite, {
      id: 'dm_acpfrom00d1',
      sessionId: ses,
      meshSessionId: 'mesh_dm0000000d1',
      fromAgent: acp,
      peer: 'human:zeke'
    });
    // Peer is the same ACP id in a second row (null sender) → Option 1 keeps it a private label, not canonical.
    insertDirectMessage(sqlite, {
      id: 'dm_acppeer00d1',
      sessionId: ses,
      meshSessionId: 'mesh_dm0000000d1',
      fromAgent: null,
      peer: acp
    });

    const result = reconcileNativeAgentMemberKeys(sqlite, AT1);
    expect(result).toEqual({ reconciled: 0, failures: 1, cleared: 0 });

    // ACP sender is not canonical → fails closed; ACP peer is not canonical → kept as a raw private label.
    expect(directRow(sqlite, 'dm_acpfrom00d1')).toEqual({ from_agent: acp, peer: 'human:zeke' });
    expect(directRow(sqlite, 'dm_acppeer00d1')).toEqual({ from_agent: null, peer: acp });
    const failures = sqlite
      .query('SELECT source_table, legacy_member_key, reason FROM native_agent_reconcile_failures')
      .all() as Array<Record<string, unknown>>;
    expect(failures).toEqual([
      { source_table: 'native_agent_direct_messages', legacy_member_key: acp, reason: 'no_match' }
    ]);
  } finally {
    store.close();
  }
});

test('direct message: after reconcile then a real DB reopen, the canonical conversation is still readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monad-dm-reopen-'));
  const path = join(dir, 'store.db');
  try {
    const prj = 'prj_dm00000008';
    const ses = 'ses_dm0000008';
    const sender = 'mem_sender0008';
    const reviewer = 'mem_review0008';

    const seed = createStore({ path });
    const seedSqlite = sqliteOf(seed);
    insertSession(seedSqlite, ses, prj);
    insertMember(seedSqlite, prj, sender);
    insertMember(seedSqlite, prj, reviewer);
    insertMeshSession(seedSqlite, 'mesh_dm00000008', ses, 'builder', sender);
    insertSessionMember(seedSqlite, ses, reviewer, { instanceId: 'reviewer' });
    insertDirectMessage(seedSqlite, {
      id: 'msg_dmreopen00008',
      sessionId: ses,
      meshSessionId: 'mesh_dm00000008',
      fromAgent: 'builder',
      peer: 'reviewer'
    });
    reconcileNativeAgentMemberKeys(seedSqlite, AT1);
    seed.close();

    // Reopen the persisted DB in a fresh store and read the conversation by the canonical peer pmid.
    const store = createStore({ path });
    try {
      const messages = store.listNativeAgentDirectMessages('mesh_dm00000008', reviewer);
      expect(messages.map((m) => ({ id: m.id, fromAgent: m.fromAgent, peer: m.peer }))).toEqual([
        { id: 'msg_dmreopen00008', fromAgent: sender, peer: reviewer }
      ]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
