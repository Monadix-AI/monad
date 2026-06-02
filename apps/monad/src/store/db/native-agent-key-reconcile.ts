import type { Database } from 'bun:sqlite';

type ReconcileFailureReason = 'no_match' | 'ambiguous' | 'ambiguous_merge';

type Resolution =
  | { kind: 'noop' }
  | { kind: 'target'; pmid: string }
  | { kind: 'failure'; reason: ReconcileFailureReason; count: number };

interface ResolveScope {
  projectId: string | null;
  sessionIds?: string[];
}

export interface ReconcileNativeAgentMemberKeysResult {
  reconciled: number;
  failures: number;
  cleared: number;
}

interface MutableResult {
  reconciled: number;
  failures: number;
  cleared: number;
}

function isCanonicalMember(sqlite: Database, projectId: string | null, memberKey: string | null): boolean {
  if (projectId === null || memberKey === null) return false;
  return (
    sqlite.query('SELECT 1 FROM project_members WHERE project_id = ? AND id = ? LIMIT 1').get(projectId, memberKey) !==
    null
  );
}

// A mesh session only owns a durable row when it belongs to the row's own scope: same project, and — when
// the row is session-scoped (asks/gates) — the mesh session's transcript target is one of the row's allowed
// sessions, with a stamped project_member_id that is a real ProjectMember of that project. Trusting
// mesh_sessions.project_member_id alone lets a foreign (cross-project OR cross-session) mesh_session_id
// re-key a row into another member — resolve fail-closed instead.
function meshSessionOwner(sqlite: Database, meshSessionId: string | null, scope: ResolveScope): string | null {
  if (meshSessionId === null || scope.projectId === null) return null;
  if (scope.sessionIds && scope.sessionIds.length === 0) return null;
  const sessionFilter = scope.sessionIds
    ? ` AND ms.transcript_target_id IN (${scope.sessionIds.map(() => '?').join(', ')})`
    : '';
  const row = sqlite
    .query(
      `SELECT ms.project_member_id AS pmid
       FROM mesh_sessions ms
       JOIN sessions s ON s.id = ms.transcript_target_id
       WHERE ms.id = ? AND s.project_id = ? AND ms.project_member_id IS NOT NULL${sessionFilter}
         AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.id = ms.project_member_id AND pm.project_id = ?)`
    )
    .get(meshSessionId, scope.projectId, ...(scope.sessionIds ?? []), scope.projectId) as { pmid: string } | null;
  return row?.pmid ?? null;
}

// Alias resolution only trusts a candidate that is a real ProjectMember of the row's own project — a
// mesh_sessions row carrying a foreign/stale project_member_id must never become a re-key target.
function aliasCandidates(sqlite: Database, legacyKey: string, scope: ResolveScope): string[] {
  if (scope.projectId === null) return [];
  if (scope.sessionIds) {
    if (scope.sessionIds.length === 0) return [];
    const placeholders = scope.sessionIds.map(() => '?').join(', ');
    // JOIN sessions and re-check s.project_id: a corrupted row whose project_session_id points at a session
    // in another project must not resolve a candidate from that foreign session.
    const rows = sqlite
      .query(
        `SELECT DISTINCT ms.project_member_id AS pmid FROM mesh_sessions ms
         JOIN sessions s ON s.id = ms.transcript_target_id
         WHERE ms.transcript_target_id IN (${placeholders}) AND s.project_id = ? AND ms.agent_name = ?
           AND ms.project_member_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.id = ms.project_member_id AND pm.project_id = ?)`
      )
      .all(...scope.sessionIds, scope.projectId, legacyKey, scope.projectId) as Array<{ pmid: string }>;
    return rows.map((row) => row.pmid);
  }
  const rows = sqlite
    .query(
      `SELECT DISTINCT ms.project_member_id AS pmid FROM mesh_sessions ms
       WHERE ms.transcript_target_id IN (SELECT id FROM sessions WHERE project_id = ?)
         AND ms.agent_name = ? AND ms.project_member_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.id = ms.project_member_id AND pm.project_id = ?)`
    )
    .all(scope.projectId, legacyKey, scope.projectId) as Array<{ pmid: string }>;
  return rows.map((row) => row.pmid);
}

function resolveMemberKey(
  sqlite: Database,
  legacyKey: string | null,
  meshSessionId: string | null,
  scope: ResolveScope
): Resolution {
  if (legacyKey !== null && isCanonicalMember(sqlite, scope.projectId, legacyKey)) return { kind: 'noop' };
  const owner = meshSessionOwner(sqlite, meshSessionId, scope);
  if (owner !== null) return owner === legacyKey ? { kind: 'noop' } : { kind: 'target', pmid: owner };
  if (legacyKey === null) return { kind: 'failure', reason: 'no_match', count: 0 };
  const candidates = aliasCandidates(sqlite, legacyKey, scope);
  if (candidates.length === 0) return { kind: 'failure', reason: 'no_match', count: 0 };
  if (candidates.length > 1) return { kind: 'failure', reason: 'ambiguous', count: candidates.length };
  const pmid = candidates[0] as string;
  return pmid === legacyKey ? { kind: 'noop' } : { kind: 'target', pmid };
}

// Direct-message peers are addressed even when offline (no live mesh_session), so alias resolution can't
// rely on mesh_sessions alone. Consult the durable session_members roster too: a runtime/display/template
// alias must map to exactly ONE real ProjectMember of the row's own project+session. Same project_members
// validation as aliasCandidates — a stale/foreign member_id is never a re-key target.
function rosterCandidates(sqlite: Database, legacyKey: string, scope: ResolveScope): string[] {
  if (scope.projectId === null || !scope.sessionIds || scope.sessionIds.length === 0) return [];
  const placeholders = scope.sessionIds.map(() => '?').join(', ');
  const rows = sqlite
    .query(
      `SELECT DISTINCT sm.member_id AS pmid FROM session_members sm
       JOIN sessions s ON s.id = sm.session_id
       WHERE sm.session_id IN (${placeholders}) AND s.project_id = ? AND sm.type = 'mesh-agent'
         AND (json_extract(sm.data, '$.instanceId') = ? OR json_extract(sm.data, '$.displayName') = ?
              OR json_extract(sm.data, '$.templateName') = ? OR json_extract(sm.data, '$.name') = ?)
         AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.id = sm.member_id AND pm.project_id = ?)`
    )
    .all(...scope.sessionIds, scope.projectId, legacyKey, legacyKey, legacyKey, legacyKey, scope.projectId) as Array<{
    pmid: string;
  }>;
  return rows.map((row) => row.pmid);
}

// Canonical membership for a direct-message identity is the identity graph, NOT project_members alone: a
// pmid counts as already-canonical only when it holds a non-left SessionBinding in the ROW's own session and
// resolves to a ProjectMember of that session's project. A same-project pmid that is not bound to this
// session is therefore never treated as a canonical member of it.
function isCanonicalMemberBound(sqlite: Database, scope: ResolveScope, memberKey: string): boolean {
  if (scope.projectId === null || !scope.sessionIds || scope.sessionIds.length === 0) return false;
  const placeholders = scope.sessionIds.map(() => '?').join(', ');
  return (
    sqlite
      .query(
        `SELECT 1 FROM session_bindings sb
         JOIN sessions s ON s.id = sb.session_id
         JOIN project_members pm ON pm.project_id = s.project_id AND pm.id = sb.project_member_id
         WHERE sb.session_id IN (${placeholders}) AND s.project_id = ? AND sb.project_member_id = ?
           AND sb.lifecycle != 'left' AND pm.type = 'mesh-agent'
         LIMIT 1`
      )
      .get(...scope.sessionIds, scope.projectId, memberKey) !== null
  );
}

// Canonical binding roster candidates: a non-left SessionBinding + its ProjectMember (mesh-agent) whose id,
// profile (template) name, or display name matches the alias. This is the primary alias source; a member
// bound purely through bindSessionMember has no legacy session_members row and is only found here.
function bindingCandidates(sqlite: Database, legacyKey: string, scope: ResolveScope): string[] {
  if (scope.projectId === null || !scope.sessionIds || scope.sessionIds.length === 0) return [];
  const placeholders = scope.sessionIds.map(() => '?').join(', ');
  const rows = sqlite
    .query(
      `SELECT DISTINCT pm.id AS pmid FROM session_bindings sb
       JOIN sessions s ON s.id = sb.session_id
       JOIN project_members pm ON pm.project_id = s.project_id AND pm.id = sb.project_member_id
       WHERE sb.session_id IN (${placeholders}) AND s.project_id = ? AND sb.lifecycle != 'left'
         AND pm.type = 'mesh-agent'
         AND (pm.id = ? OR pm.profile_id = ? OR pm.display_name = ?)`
    )
    .all(...scope.sessionIds, scope.projectId, legacyKey, legacyKey, legacyKey) as Array<{ pmid: string }>;
  return rows.map((row) => row.pmid);
}

// A direct-message identity resolves to a canonical member via, in order: the row's own mesh_session owner
// (sender only — peer passes meshSessionId=null), which is AUTHORITATIVE and wins even when the stored key is
// itself some other same-project member; then already-canonical-and-bound noop; then the combined roster
// (canonical bindings ∪ historical mesh_sessions.agent_name ∪ legacy session_members). A union of >1 distinct
// pmid is ambiguous and fails closed. `zeroCandidatesNoop` splits the two roles on a zero-candidate miss: a
// SENDER (false) must map to a member, so a miss is a no_match failure; a PEER (true) is legitimately a
// non-member private label, so a miss is a keep-as-is noop — there is no reliable pmid syntax to tell a
// mistyped member from an intentional private label, so the private-ledger reading wins.
function resolveDirectIdentity(
  sqlite: Database,
  legacyKey: string | null,
  meshSessionId: string | null,
  scope: ResolveScope,
  zeroCandidatesNoop: boolean
): Resolution {
  const owner = meshSessionOwner(sqlite, meshSessionId, scope);
  if (owner !== null) return owner === legacyKey ? { kind: 'noop' } : { kind: 'target', pmid: owner };
  if (legacyKey !== null && isCanonicalMemberBound(sqlite, scope, legacyKey)) return { kind: 'noop' };
  const noMatch: Resolution = zeroCandidatesNoop ? { kind: 'noop' } : { kind: 'failure', reason: 'no_match', count: 0 };
  if (legacyKey === null) return noMatch;
  const candidates = [
    ...new Set([
      ...bindingCandidates(sqlite, legacyKey, scope),
      ...aliasCandidates(sqlite, legacyKey, scope),
      ...rosterCandidates(sqlite, legacyKey, scope)
    ])
  ];
  if (candidates.length === 0) return noMatch;
  if (candidates.length > 1) return { kind: 'failure', reason: 'ambiguous', count: candidates.length };
  const pmid = candidates[0] as string;
  return pmid === legacyKey ? { kind: 'noop' } : { kind: 'target', pmid };
}

// NUL joins composite scope keys: ids never contain it, so distinct (a, b) tuples can never alias. Kept
// as a helper (never an inline byte) so the separator stays a named constant instead of a raw/opaque
// character in the source.
const TUPLE_SEP = String.fromCharCode(0);
function tupleKey(...parts: Array<string | number>): string {
  return parts.join(TUPLE_SEP);
}

function failureId(sourceTable: string, identity: string): string {
  return `reconcilefail:${sourceTable}:${identity}`;
}

interface FailureInput {
  id: string;
  sourceTable: string;
  projectId: string | null;
  sessionId: string | null;
  legacyMemberKey: string;
  candidateCount: number;
  reason: ReconcileFailureReason;
  at: string;
}

function recordFailure(sqlite: Database, input: FailureInput): boolean {
  const inserted = sqlite
    .query(
      `INSERT OR IGNORE INTO native_agent_reconcile_failures
         (id, source_table, project_id, session_id, legacy_member_key, candidate_count, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.sourceTable,
      input.projectId,
      input.sessionId,
      input.legacyMemberKey,
      input.candidateCount,
      input.reason,
      input.at,
      input.at
    ).changes;
  const updated = sqlite
    .query(
      `UPDATE native_agent_reconcile_failures
       SET candidate_count = ?, reason = ?, project_id = ?, session_id = ?, legacy_member_key = ?, updated_at = ?
       WHERE id = ? AND (candidate_count != ? OR reason != ?)`
    )
    .run(
      input.candidateCount,
      input.reason,
      input.projectId,
      input.sessionId,
      input.legacyMemberKey,
      input.at,
      input.id,
      input.candidateCount,
      input.reason
    ).changes;
  return inserted > 0 || updated > 0;
}

function clearFailure(sqlite: Database, id: string): number {
  return sqlite.query('DELETE FROM native_agent_reconcile_failures WHERE id = ?').run(id).changes;
}

interface TouchedNamespace {
  projectId: string;
  target: string;
}

function reconcileIngressItems(
  sqlite: Database,
  at: string,
  result: MutableResult,
  touched: Map<string, TouchedNamespace>
): void {
  const rows = sqlite
    .query(
      `SELECT id, project_id, member_instance_id, mesh_session_id, ingress_seq, message_id
       FROM native_agent_ingress_items
       ORDER BY project_id, member_instance_id, ingress_seq`
    )
    .all() as Array<{
    id: string;
    project_id: string;
    member_instance_id: string;
    mesh_session_id: string | null;
    ingress_seq: number;
    message_id: string | null;
  }>;

  const migrating: Array<{
    id: string;
    projectId: string;
    oldKey: string;
    target: string;
    ingressSeq: number;
    messageId: string | null;
  }> = [];
  for (const row of rows) {
    const res = resolveMemberKey(sqlite, row.member_instance_id, row.mesh_session_id, { projectId: row.project_id });
    const fid = failureId('native_agent_ingress_items', row.id);
    if (res.kind === 'noop') {
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    if (res.kind === 'failure') {
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'native_agent_ingress_items',
          projectId: row.project_id,
          sessionId: null,
          legacyMemberKey: row.member_instance_id,
          candidateCount: res.count,
          reason: res.reason,
          at
        })
      )
        result.failures += 1;
      continue;
    }
    migrating.push({
      id: row.id,
      projectId: row.project_id,
      oldKey: row.member_instance_id,
      target: res.pmid,
      ingressSeq: row.ingress_seq,
      messageId: row.message_id
    });
  }

  const groups = new Map<string, typeof migrating>();
  for (const item of migrating) {
    const key = tupleKey(item.projectId, item.target);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(item);
  }

  const del = sqlite.query('DELETE FROM native_agent_ingress_items WHERE id = ?');
  const move = sqlite.query(
    'UPDATE native_agent_ingress_items SET member_instance_id = ?, ingress_seq = ?, updated_at = ? WHERE id = ?'
  );
  for (const [, items] of groups) {
    const first = items[0] as (typeof items)[number];
    const { projectId, target } = first;
    const canonical = sqlite
      .query(
        'SELECT ingress_seq, message_id FROM native_agent_ingress_items WHERE project_id = ? AND member_instance_id = ?'
      )
      .all(projectId, target) as Array<{ ingress_seq: number; message_id: string | null }>;
    let maxSeq = 0;
    const messageIds = new Set<string>();
    for (const canon of canonical) {
      if (canon.ingress_seq > maxSeq) maxSeq = canon.ingress_seq;
      if (canon.message_id !== null) messageIds.add(canon.message_id);
    }
    items.sort(
      (a, b) =>
        a.ingressSeq - b.ingressSeq ||
        (a.oldKey < b.oldKey ? -1 : a.oldKey > b.oldKey ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    let assigned = maxSeq;
    for (const item of items) {
      const fid = failureId('native_agent_ingress_items', item.id);
      if (item.messageId !== null && messageIds.has(item.messageId)) {
        del.run(item.id);
        result.cleared += clearFailure(sqlite, fid);
        result.reconciled += 1;
        continue;
      }
      assigned += 1;
      move.run(target, assigned, at, item.id);
      if (item.messageId !== null) messageIds.add(item.messageId);
      result.cleared += clearFailure(sqlite, fid);
      result.reconciled += 1;
    }
    touched.set(tupleKey(projectId, target), { projectId, target });
  }
}

function reconcileIngressCounters(
  sqlite: Database,
  at: string,
  result: MutableResult,
  touched: Map<string, TouchedNamespace>
): void {
  const rows = sqlite
    .query('SELECT project_id, member_instance_id, next_seq FROM mesh_agent_ingress_counters')
    .all() as Array<{ project_id: string; member_instance_id: string; next_seq: number }>;
  for (const row of rows) {
    const res = resolveMemberKey(sqlite, row.member_instance_id, null, { projectId: row.project_id });
    const fid = failureId('mesh_agent_ingress_counters', tupleKey(row.project_id, row.member_instance_id));
    if (res.kind === 'noop') {
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    if (res.kind === 'failure') {
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'mesh_agent_ingress_counters',
          projectId: row.project_id,
          sessionId: null,
          legacyMemberKey: row.member_instance_id,
          candidateCount: res.count,
          reason: res.reason,
          at
        })
      )
        result.failures += 1;
      continue;
    }
    const target = res.pmid;
    const existing = sqlite
      .query('SELECT next_seq FROM mesh_agent_ingress_counters WHERE project_id = ? AND member_instance_id = ?')
      .get(row.project_id, target) as { next_seq: number } | null;
    if (existing) {
      const merged = Math.max(existing.next_seq, row.next_seq);
      if (merged !== existing.next_seq) {
        sqlite
          .query(
            'UPDATE mesh_agent_ingress_counters SET next_seq = ?, updated_at = ? WHERE project_id = ? AND member_instance_id = ?'
          )
          .run(merged, at, row.project_id, target);
      }
      sqlite
        .query('DELETE FROM mesh_agent_ingress_counters WHERE project_id = ? AND member_instance_id = ?')
        .run(row.project_id, row.member_instance_id);
    } else {
      sqlite
        .query(
          'UPDATE mesh_agent_ingress_counters SET member_instance_id = ?, updated_at = ? WHERE project_id = ? AND member_instance_id = ?'
        )
        .run(target, at, row.project_id, row.member_instance_id);
    }
    result.reconciled += 1;
    result.cleared += clearFailure(sqlite, fid);
    touched.set(tupleKey(row.project_id, target), { projectId: row.project_id, target });
  }

  for (const { projectId, target } of touched.values()) {
    const maxRow = sqlite
      .query(
        'SELECT MAX(ingress_seq) AS m FROM native_agent_ingress_items WHERE project_id = ? AND member_instance_id = ?'
      )
      .get(projectId, target) as { m: number | null };
    const needed = (maxRow.m ?? 0) + 1;
    const counter = sqlite
      .query('SELECT next_seq FROM mesh_agent_ingress_counters WHERE project_id = ? AND member_instance_id = ?')
      .get(projectId, target) as { next_seq: number } | null;
    if (counter) {
      if (counter.next_seq < needed) {
        sqlite
          .query(
            'UPDATE mesh_agent_ingress_counters SET next_seq = ?, updated_at = ? WHERE project_id = ? AND member_instance_id = ?'
          )
          .run(needed, at, projectId, target);
      }
    } else if (maxRow.m !== null) {
      sqlite
        .query(
          'INSERT INTO mesh_agent_ingress_counters (project_id, member_instance_id, next_seq, updated_at) VALUES (?, ?, ?, ?)'
        )
        .run(projectId, target, needed, at);
    }
  }
}

function reconcileAsks(sqlite: Database, at: string, result: MutableResult): void {
  const rows = sqlite
    .query(
      'SELECT request_id, project_id, project_session_id, member_instance_id, mesh_session_id, resolved_at FROM native_agent_asks'
    )
    .all() as Array<{
    request_id: string;
    project_id: string;
    project_session_id: string;
    member_instance_id: string;
    mesh_session_id: string | null;
    resolved_at: string | null;
  }>;

  const move = sqlite.query('UPDATE native_agent_asks SET member_instance_id = ?, updated_at = ? WHERE request_id = ?');
  const unresolvedByTarget = new Map<
    string,
    { sessionId: string; target: string; contenders: Array<{ requestId: string; oldKey: string; projectId: string }> }
  >();
  for (const row of rows) {
    const scope: ResolveScope = { projectId: row.project_id, sessionIds: [row.project_session_id] };
    const res = resolveMemberKey(sqlite, row.member_instance_id, row.mesh_session_id, scope);
    const fid = failureId('native_agent_asks', row.request_id);
    if (res.kind === 'noop') {
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    if (res.kind === 'failure') {
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'native_agent_asks',
          projectId: row.project_id,
          sessionId: row.project_session_id,
          legacyMemberKey: row.member_instance_id,
          candidateCount: res.count,
          reason: res.reason,
          at
        })
      )
        result.failures += 1;
      continue;
    }
    const target = res.pmid;
    if (row.resolved_at !== null) {
      move.run(target, at, row.request_id);
      result.reconciled += 1;
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    const key = tupleKey(row.project_session_id, target);
    let bucket = unresolvedByTarget.get(key);
    if (!bucket) {
      bucket = { sessionId: row.project_session_id, target, contenders: [] };
      unresolvedByTarget.set(key, bucket);
    }
    bucket.contenders.push({ requestId: row.request_id, oldKey: row.member_instance_id, projectId: row.project_id });
  }

  for (const { sessionId, target, contenders } of unresolvedByTarget.values()) {
    const canonical = sqlite
      .query(
        'SELECT request_id FROM native_agent_asks WHERE project_session_id = ? AND member_instance_id = ? AND resolved_at IS NULL'
      )
      .get(sessionId, target) as { request_id: string } | null;
    contenders.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
    let slotTaken = canonical !== null;
    for (const contender of contenders) {
      const fid = failureId('native_agent_asks', contender.requestId);
      if (!slotTaken) {
        move.run(target, at, contender.requestId);
        result.reconciled += 1;
        result.cleared += clearFailure(sqlite, fid);
        slotTaken = true;
        continue;
      }
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'native_agent_asks',
          projectId: contender.projectId,
          sessionId,
          legacyMemberKey: contender.oldKey,
          candidateCount: contenders.length + (canonical ? 1 : 0),
          reason: 'ambiguous_merge',
          at
        })
      )
        result.failures += 1;
    }
  }
}

// A member gate is a satellite of its ask: it must carry exactly the key its ask (matched by request_id)
// holds AFTER ask reconciliation, never an independently-resolved key. Resolving the gate on its own can
// fork the (session, member) slot away from the ask when two aliases collide on one pmid — the winning ask
// and the surviving gate could then point at different requests. Runs after reconcileAsks.
function reconcileMemberGates(sqlite: Database, at: string, result: MutableResult): void {
  const rows = sqlite
    .query('SELECT project_id, project_session_id, member_instance_id, request_id FROM native_agent_member_gates')
    .all() as Array<{
    project_id: string;
    project_session_id: string;
    member_instance_id: string;
    request_id: string;
  }>;
  for (const row of rows) {
    const fid = failureId('native_agent_member_gates', tupleKey(row.project_session_id, row.member_instance_id));
    const flagAmbiguousMerge = (count: number): void => {
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'native_agent_member_gates',
          projectId: row.project_id,
          sessionId: row.project_session_id,
          legacyMemberKey: row.member_instance_id,
          candidateCount: count,
          reason: 'ambiguous_merge',
          at
        })
      )
        result.failures += 1;
    };
    const ask = sqlite
      .query('SELECT member_instance_id, project_session_id FROM native_agent_asks WHERE request_id = ?')
      .get(row.request_id) as { member_instance_id: string; project_session_id: string } | null;
    if (!ask || ask.project_session_id !== row.project_session_id) {
      flagAmbiguousMerge(0);
      continue;
    }
    const target = ask.member_instance_id;
    if (target === row.member_instance_id) {
      // Gate already matches its ask's key (both canonical, or both still on a legacy alias whose ask lost
      // an ambiguous merge). Consistent with the ask, so leave it and drop any stale failure.
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    const existing = sqlite
      .query('SELECT request_id FROM native_agent_member_gates WHERE project_session_id = ? AND member_instance_id = ?')
      .get(row.project_session_id, target) as { request_id: string } | null;
    if (existing) {
      if (existing.request_id !== row.request_id) {
        // The canonical slot is held by a different request; merging would drop a gate's ask binding.
        flagAmbiguousMerge(2);
        continue;
      }
      sqlite
        .query('DELETE FROM native_agent_member_gates WHERE project_session_id = ? AND member_instance_id = ?')
        .run(row.project_session_id, row.member_instance_id);
    } else {
      sqlite
        .query(
          'UPDATE native_agent_member_gates SET member_instance_id = ?, updated_at = ? WHERE project_session_id = ? AND member_instance_id = ?'
        )
        .run(target, at, row.project_session_id, row.member_instance_id);
    }
    result.reconciled += 1;
    result.cleared += clearFailure(sqlite, fid);
  }
}

function reconcileRecoveryBatches(sqlite: Database, at: string, result: MutableResult): void {
  const rows = sqlite
    .query('SELECT id, project_id, member_instance_id, ask_request_id FROM native_agent_recovery_batches')
    .all() as Array<{ id: string; project_id: string; member_instance_id: string; ask_request_id: string | null }>;
  for (const row of rows) {
    let scope: ResolveScope;
    if (row.ask_request_id !== null) {
      const ask = sqlite
        .query('SELECT project_session_id FROM native_agent_asks WHERE request_id = ?')
        .get(row.ask_request_id) as { project_session_id: string } | null;
      scope = ask ? { projectId: row.project_id, sessionIds: [ask.project_session_id] } : { projectId: row.project_id };
    } else {
      scope = { projectId: row.project_id };
    }
    const res = resolveMemberKey(sqlite, row.member_instance_id, null, scope);
    const fid = failureId('native_agent_recovery_batches', row.id);
    if (res.kind === 'noop') {
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    if (res.kind === 'failure') {
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'native_agent_recovery_batches',
          projectId: row.project_id,
          sessionId: null,
          legacyMemberKey: row.member_instance_id,
          candidateCount: res.count,
          reason: res.reason,
          at
        })
      )
        result.failures += 1;
      continue;
    }
    sqlite
      .query('UPDATE native_agent_recovery_batches SET member_instance_id = ?, updated_at = ? WHERE id = ?')
      .run(res.pmid, at, row.id);
    result.reconciled += 1;
    result.cleared += clearFailure(sqlite, fid);
  }
}

function reconcileInboxItems(sqlite: Database, at: string, result: MutableResult): void {
  const rows = sqlite
    .query('SELECT mesh_session_id, message_seq, project_id, member_instance_id FROM mesh_agent_inbox_items')
    .all() as Array<{
    mesh_session_id: string;
    message_seq: number;
    project_id: string | null;
    member_instance_id: string | null;
  }>;
  for (const row of rows) {
    const ms = sqlite.query('SELECT transcript_target_id FROM mesh_sessions WHERE id = ?').get(row.mesh_session_id) as {
      transcript_target_id: string;
    } | null;
    let projectId = row.project_id;
    if (projectId === null && ms) {
      const session = sqlite.query('SELECT project_id FROM sessions WHERE id = ?').get(ms.transcript_target_id) as {
        project_id: string | null;
      } | null;
      projectId = session?.project_id ?? null;
    }
    const scope: ResolveScope = { projectId, ...(ms ? { sessionIds: [ms.transcript_target_id] } : {}) };
    const res = resolveMemberKey(sqlite, row.member_instance_id, row.mesh_session_id, scope);
    const fid = failureId('mesh_agent_inbox_items', tupleKey(row.mesh_session_id, row.message_seq));
    if (res.kind === 'noop') {
      result.cleared += clearFailure(sqlite, fid);
      continue;
    }
    if (res.kind === 'failure') {
      if (
        recordFailure(sqlite, {
          id: fid,
          sourceTable: 'mesh_agent_inbox_items',
          projectId,
          sessionId: ms?.transcript_target_id ?? null,
          legacyMemberKey: row.member_instance_id ?? '',
          candidateCount: res.count,
          reason: res.reason,
          at
        })
      )
        result.failures += 1;
      continue;
    }
    sqlite
      .query(
        'UPDATE mesh_agent_inbox_items SET member_instance_id = ?, updated_at = ? WHERE mesh_session_id = ? AND message_seq = ?'
      )
      .run(res.pmid, at, row.mesh_session_id, row.message_seq);
    result.reconciled += 1;
    result.cleared += clearFailure(sqlite, fid);
  }
}

// Direct messages carry durable identity in from_agent + peer. Unlike the routing tables above, a row's two
// identity fields converge as ONE atomic pair: a single UPDATE only when BOTH sides resolve (to a canonical
// target or a keep-as-is noop), so a partial resolution never leaves a canonical/alias hybrid row. from_agent
// null is a legitimate sender-less message — kept null by contract, never treated as a failure. Ledger entries
// are per (row, field) so a resolvable field and a stuck one are tracked independently.
function reconcileDirectMessages(sqlite: Database, at: string, result: MutableResult): void {
  const rows = sqlite
    .query(
      `SELECT d.id, d.session_id, d.mesh_session_id, d.from_agent, d.peer, s.project_id
       FROM native_agent_direct_messages d
       JOIN sessions s ON s.id = d.session_id`
    )
    .all() as Array<{
    id: string;
    session_id: string;
    mesh_session_id: string;
    from_agent: string | null;
    peer: string;
    project_id: string | null;
  }>;
  const move = sqlite.query('UPDATE native_agent_direct_messages SET from_agent = ?, peer = ? WHERE id = ?');
  for (const row of rows) {
    const scope: ResolveScope = { projectId: row.project_id, sessionIds: [row.session_id] };
    const fromRes: Resolution =
      row.from_agent === null
        ? { kind: 'noop' }
        : resolveDirectIdentity(sqlite, row.from_agent, row.mesh_session_id, scope, false);
    const peerRes: Resolution = resolveDirectIdentity(sqlite, row.peer, null, scope, true);
    const fromFid = failureId('native_agent_direct_messages', tupleKey(row.id, 'from_agent'));
    const peerFid = failureId('native_agent_direct_messages', tupleKey(row.id, 'peer'));

    if (fromRes.kind === 'failure' || peerRes.kind === 'failure') {
      if (fromRes.kind === 'failure') {
        if (
          recordFailure(sqlite, {
            id: fromFid,
            sourceTable: 'native_agent_direct_messages',
            projectId: row.project_id,
            sessionId: row.session_id,
            legacyMemberKey: row.from_agent ?? '',
            candidateCount: fromRes.count,
            reason: fromRes.reason,
            at
          })
        )
          result.failures += 1;
      } else {
        result.cleared += clearFailure(sqlite, fromFid);
      }
      if (peerRes.kind === 'failure') {
        if (
          recordFailure(sqlite, {
            id: peerFid,
            sourceTable: 'native_agent_direct_messages',
            projectId: row.project_id,
            sessionId: row.session_id,
            legacyMemberKey: row.peer,
            candidateCount: peerRes.count,
            reason: peerRes.reason,
            at
          })
        )
          result.failures += 1;
      } else {
        result.cleared += clearFailure(sqlite, peerFid);
      }
      continue;
    }

    const newFrom = fromRes.kind === 'target' ? fromRes.pmid : row.from_agent;
    const newPeer = peerRes.kind === 'target' ? peerRes.pmid : row.peer;
    if (newFrom !== row.from_agent || newPeer !== row.peer) {
      move.run(newFrom, newPeer, row.id);
      result.reconciled += 1;
    }
    result.cleared += clearFailure(sqlite, fromFid);
    result.cleared += clearFailure(sqlite, peerFid);
  }
}

export function reconcileNativeAgentMemberKeys(
  sqlite: Database,
  at = new Date().toISOString()
): ReconcileNativeAgentMemberKeysResult {
  return sqlite.transaction((): ReconcileNativeAgentMemberKeysResult => {
    const result: MutableResult = { reconciled: 0, failures: 0, cleared: 0 };
    const touched = new Map<string, TouchedNamespace>();
    reconcileIngressItems(sqlite, at, result, touched);
    reconcileIngressCounters(sqlite, at, result, touched);
    reconcileAsks(sqlite, at, result);
    reconcileMemberGates(sqlite, at, result);
    reconcileRecoveryBatches(sqlite, at, result);
    reconcileInboxItems(sqlite, at, result);
    reconcileDirectMessages(sqlite, at, result);
    return result;
  })();
}
