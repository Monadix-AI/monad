import type { Session } from '@monad/protocol';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';

const session: MeshSessionRow = {
  id: 'mesh_usage0000001',
  transcriptTargetId: 'ses_usagesess001',
  agentName: 'codex',
  provider: 'codex',
  workingPath: '/tmp/project',
  runtimeRole: 'interactive',
  agentRuntimeId: null,
  agentRuntimeTokenHash: null,
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  state: 'running',
  pid: 42,
  providerSessionRef: 'provider-session',
  outputSnapshot: '',
  exitCode: null,
  startedAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  exitedAt: null
};

test('Mesh usage snapshots replace provider records and update normalized session totals', () => {
  const store = createStore();
  store.insertSession({
    id: 'ses_usagesess001',
    projectId: 'prj_usageproj001',
    title: 'Usage project session',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z'
  } as Session);
  store.replaceMeshAgentUsageSnapshot({
    agentName: 'codex',
    provider: 'codex',
    checkedAt: '2026-08-03T00:01:00.000Z',
    records: [
      { name: 'five-hour', current: 25, max: 100 },
      { name: 'weekly', current: 40, max: 200 }
    ]
  });
  store.replaceMeshAgentUsageSnapshot({
    agentName: 'codex',
    provider: 'codex',
    checkedAt: '2026-08-03T00:02:00.000Z',
    records: [{ name: 'weekly', current: 60, max: 200, resetAt: '2026-08-10T00:00:00.000Z' }]
  });
  store.upsertMeshSessionUsageSnapshot(session, { total: 100, input: 70, output: 30 }, '2026-08-03T00:03:00.000Z');
  store.upsertMeshSessionUsageSnapshot(session, { total: 150, input: 100, output: 50 }, '2026-08-03T00:04:00.000Z');

  expect(store.listMeshUsageOverview('2026-08-03T00:05:00.000Z')).toEqual({
    checkedAt: '2026-08-03T00:05:00.000Z',
    providerUsage: [
      {
        agentName: 'codex',
        provider: 'codex',
        checkedAt: '2026-08-03T00:02:00.000Z',
        records: [{ name: 'weekly', current: 60, max: 200, resetAt: '2026-08-10T00:00:00.000Z' }]
      }
    ],
    sessionUsage: [
      {
        meshSessionId: 'mesh_usage0000001',
        sessionId: 'ses_usagesess001',
        projectId: 'prj_usageproj001',
        agentName: 'codex',
        provider: 'codex',
        checkedAt: '2026-08-03T00:04:00.000Z',
        total: 150,
        input: 100,
        output: 50
      }
    ]
  });
  store.close();
});
