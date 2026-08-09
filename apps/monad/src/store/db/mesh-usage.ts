import type { Database } from 'bun:sqlite';
import type {
  MeshAgentSessionUsage,
  MeshAgentUsageResponse,
  MeshUsageOverviewResponse,
  ProjectId
} from '@monad/protocol';
import type { MeshSessionRow } from './mesh-sessions.ts';

import {
  meshAgentSessionUsageSchema,
  meshAgentUsageResponseSchema,
  meshUsageOverviewResponseSchema
} from '@monad/protocol';

interface AgentUsageSnapshotRow {
  agent_name: string;
  checked_at: string;
  provider: string;
}

interface AgentUsageRecordRow extends AgentUsageSnapshotRow {
  current: number;
  max: number | null;
  name: string;
  reset_at: string | null;
}

interface SessionUsageSnapshotRow {
  agent_name: string;
  checked_at: string;
  input: number;
  member_display_name: string | null;
  mesh_session_id: string;
  output: number;
  project_member_id: string | null;
  project_id: string | null;
  provider: string;
  session_id: string;
  session_title: string | null;
  total: number;
}

export function replaceMeshAgentUsageSnapshot(sqlite: Database, input: MeshAgentUsageResponse): void {
  const snapshot = meshAgentUsageResponseSchema.parse(input);
  sqlite.transaction(() => {
    sqlite
      .query(
        `INSERT INTO mesh_agent_usage_snapshots (provider, agent_name, checked_at)
         VALUES ($provider, $agentName, $checkedAt)
         ON CONFLICT(provider, agent_name) DO UPDATE SET checked_at = excluded.checked_at`
      )
      .run({
        $provider: snapshot.provider,
        $agentName: snapshot.agentName,
        $checkedAt: snapshot.checkedAt
      });
    sqlite
      .query('DELETE FROM mesh_agent_usage_records WHERE provider = $provider AND agent_name = $agentName')
      .run({ $provider: snapshot.provider, $agentName: snapshot.agentName });
    const insertRecord = sqlite.query(
      `INSERT INTO mesh_agent_usage_records
         (provider, agent_name, name, current, max, reset_at, checked_at)
       VALUES ($provider, $agentName, $name, $current, $max, $resetAt, $checkedAt)`
    );
    for (const record of snapshot.records) {
      insertRecord.run({
        $provider: snapshot.provider,
        $agentName: snapshot.agentName,
        $name: record.name,
        $current: record.current,
        $max: record.max ?? null,
        $resetAt: record.resetAt ?? null,
        $checkedAt: snapshot.checkedAt
      });
    }
  })();
}

export function upsertMeshSessionUsageSnapshot(
  sqlite: Database,
  session: MeshSessionRow,
  projectId: ProjectId | null,
  input: MeshAgentSessionUsage,
  checkedAt = new Date().toISOString()
): void {
  const usage = meshAgentSessionUsageSchema.parse(input);
  sqlite
    .query(
      `INSERT INTO mesh_session_usage_snapshots
         (mesh_session_id, session_id, project_id, provider, agent_name, total, input, output, checked_at)
       VALUES ($meshSessionId, $sessionId, $projectId, $provider, $agentName, $total, $input, $output, $checkedAt)
       ON CONFLICT(mesh_session_id) DO UPDATE SET
         session_id = excluded.session_id,
         project_id = excluded.project_id,
         provider = excluded.provider,
         agent_name = excluded.agent_name,
         total = excluded.total,
         input = excluded.input,
         output = excluded.output,
         checked_at = excluded.checked_at`
    )
    .run({
      $meshSessionId: session.id,
      $sessionId: session.transcriptTargetId,
      $projectId: projectId,
      $provider: session.provider,
      $agentName: session.agentName,
      $total: usage.total,
      $input: usage.input,
      $output: usage.output,
      $checkedAt: checkedAt
    });
}

export function listMeshUsageOverview(
  sqlite: Database,
  checkedAt = new Date().toISOString()
): MeshUsageOverviewResponse {
  const snapshots = sqlite
    .query('SELECT provider, agent_name, checked_at FROM mesh_agent_usage_snapshots ORDER BY provider, agent_name')
    .all() as AgentUsageSnapshotRow[];
  const records = sqlite
    .query(
      `SELECT provider, agent_name, name, current, max, reset_at, checked_at
       FROM mesh_agent_usage_records
       ORDER BY provider, agent_name, name`
    )
    .all() as AgentUsageRecordRow[];
  const recordsByAgent = new Map<string, AgentUsageRecordRow[]>();
  for (const record of records) {
    const key = `${record.provider}\u0000${record.agent_name}`;
    const rows = recordsByAgent.get(key);
    if (rows) rows.push(record);
    else recordsByAgent.set(key, [record]);
  }
  const providerUsage = snapshots.map((snapshot) => ({
    provider: snapshot.provider,
    agentName: snapshot.agent_name,
    checkedAt: snapshot.checked_at,
    records: (recordsByAgent.get(`${snapshot.provider}\u0000${snapshot.agent_name}`) ?? []).map((record) => ({
      name: record.name,
      current: record.current,
      ...(record.max === null ? {} : { max: record.max }),
      ...(record.reset_at === null ? {} : { resetAt: record.reset_at })
    }))
  }));
  const sessionUsage = (
    sqlite
      .query(
        `SELECT usage.mesh_session_id, usage.session_id, usage.project_id, usage.provider,
                usage.agent_name, usage.total, usage.input, usage.output, usage.checked_at,
                sessions.title AS session_title,
                COALESCE(mesh_sessions.project_member_id, project_members.id) AS project_member_id,
                project_members.display_name AS member_display_name
         FROM mesh_session_usage_snapshots usage
         LEFT JOIN sessions ON sessions.id = usage.session_id
         LEFT JOIN mesh_sessions ON mesh_sessions.id = usage.mesh_session_id
         LEFT JOIN project_members
           ON project_members.id = COALESCE(mesh_sessions.project_member_id, usage.agent_name)
          AND project_members.project_id = usage.project_id
         ORDER BY usage.project_id, usage.provider, usage.agent_name, usage.mesh_session_id`
      )
      .all() as SessionUsageSnapshotRow[]
  ).map((row) => ({
    meshSessionId: row.mesh_session_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title ?? row.session_id,
    projectId: row.project_id,
    projectMemberId: row.project_member_id,
    provider: row.provider,
    agentName: row.agent_name,
    agentDisplayName: row.member_display_name ?? row.agent_name,
    total: row.total,
    input: row.input,
    output: row.output,
    checkedAt: row.checked_at
  }));
  return meshUsageOverviewResponseSchema.parse({ checkedAt, providerUsage, sessionUsage });
}
