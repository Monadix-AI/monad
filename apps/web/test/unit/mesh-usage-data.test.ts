import { expect, test } from 'bun:test';
import { meshUsageOverviewResponseSchema } from '@monad/protocol';

import { buildMeshUsageView } from '../../src/features/studio/mesh-usage-data';

test('Mesh usage view ranks sessions per provider and named agent members per session', () => {
  const view = buildMeshUsageView(
    meshUsageOverviewResponseSchema.parse({
      checkedAt: '2026-08-03T01:00:00.000Z',
      providerUsage: [
        {
          agentName: 'claude',
          provider: 'claude-code',
          checkedAt: '2026-08-03T00:59:00.000Z',
          records: [{ name: 'weekly', current: 20, max: 100 }]
        },
        {
          agentName: 'codex',
          provider: 'codex',
          checkedAt: '2026-08-03T00:58:00.000Z',
          records: []
        }
      ],
      sessionUsage: [
        {
          meshSessionId: 'mesh_usageview001',
          sessionId: 'ses_sessusage001',
          sessionTitle: 'Launch planning',
          projectId: 'prj_projusage001',
          projectMemberId: 'pmem_researcher001',
          agentName: 'pmem_researcher001',
          agentDisplayName: 'Researcher',
          provider: 'codex',
          checkedAt: '2026-08-03T00:57:00.000Z',
          total: 100,
          input: 70,
          output: 30
        },
        {
          meshSessionId: 'mesh_usageview002',
          sessionId: 'ses_sessusage001',
          sessionTitle: 'Launch planning',
          projectId: 'prj_projusage001',
          projectMemberId: 'pmem_editor000001',
          agentName: 'pmem_editor000001',
          agentDisplayName: 'Editor',
          provider: 'claude-code',
          checkedAt: '2026-08-03T00:56:00.000Z',
          total: 50,
          input: 40,
          output: 10
        },
        {
          meshSessionId: 'mesh_usageview003',
          sessionId: 'ses_sessusage003',
          sessionTitle: 'Support review',
          projectId: 'prj_projusage002',
          projectMemberId: 'pmem_reviewer0001',
          agentName: 'pmem_reviewer0001',
          agentDisplayName: 'Reviewer',
          provider: 'codex',
          checkedAt: '2026-08-03T00:55:00.000Z',
          total: 25,
          input: 15,
          output: 10
        }
      ]
    })
  );

  expect(view).toEqual({
    agents: 3,
    sessions: 2,
    totals: { total: 175, input: 125, output: 50 },
    providers: [
      {
        provider: 'codex',
        agentCount: 2,
        projectIds: ['prj_projusage001', 'prj_projusage002'],
        providerUsage: [
          {
            agentName: 'codex',
            provider: 'codex',
            checkedAt: '2026-08-03T00:58:00.000Z',
            records: []
          }
        ],
        sessionCount: 2,
        topSessions: [
          {
            id: 'ses_sessusage001',
            name: 'Launch planning',
            total: 100,
            input: 70,
            output: 30
          },
          {
            id: 'ses_sessusage003',
            name: 'Support review',
            total: 25,
            input: 15,
            output: 10
          }
        ],
        total: 125,
        input: 85,
        output: 40
      },
      {
        provider: 'claude-code',
        agentCount: 1,
        projectIds: ['prj_projusage001'],
        providerUsage: [
          {
            agentName: 'claude',
            provider: 'claude-code',
            checkedAt: '2026-08-03T00:59:00.000Z',
            records: [{ name: 'weekly', current: 20, max: 100 }]
          }
        ],
        sessionCount: 1,
        topSessions: [
          {
            id: 'ses_sessusage001',
            name: 'Launch planning',
            total: 50,
            input: 40,
            output: 10
          }
        ],
        total: 50,
        input: 40,
        output: 10
      }
    ],
    projects: ['prj_projusage001', 'prj_projusage002'],
    sessionGroups: [
      {
        sessionId: 'ses_sessusage001',
        sessionTitle: 'Launch planning',
        projectId: 'prj_projusage001',
        providerNames: ['claude-code', 'codex'],
        agentCount: 2,
        topAgents: [
          {
            id: 'pmem_researcher001',
            name: 'Researcher',
            provider: 'codex',
            total: 100,
            input: 70,
            output: 30
          },
          {
            id: 'pmem_editor000001',
            name: 'Editor',
            provider: 'claude-code',
            total: 50,
            input: 40,
            output: 10
          }
        ],
        total: 150,
        input: 110,
        output: 40
      },
      {
        sessionId: 'ses_sessusage003',
        sessionTitle: 'Support review',
        projectId: 'prj_projusage002',
        providerNames: ['codex'],
        agentCount: 1,
        topAgents: [
          {
            id: 'pmem_reviewer0001',
            name: 'Reviewer',
            provider: 'codex',
            total: 25,
            input: 15,
            output: 10
          }
        ],
        total: 25,
        input: 15,
        output: 10
      }
    ]
  });
});

test('Mesh usage provider ranking keeps only the three highest-usage sessions', () => {
  const view = buildMeshUsageView(
    meshUsageOverviewResponseSchema.parse({
      checkedAt: '2026-08-03T01:00:00.000Z',
      providerUsage: [],
      sessionUsage: [
        ['mesh_topusage0001', 'ses_topusage0001', 'First', 10],
        ['mesh_topusage0002', 'ses_topusage0002', 'Second', 40],
        ['mesh_topusage0003', 'ses_topusage0003', 'Third', 20],
        ['mesh_topusage0004', 'ses_topusage0004', 'Fourth', 30]
      ].map(([meshSessionId, sessionId, sessionTitle, total]) => ({
        meshSessionId,
        sessionId,
        sessionTitle,
        projectId: null,
        projectMemberId: null,
        agentName: 'codex',
        agentDisplayName: 'Codex',
        provider: 'codex',
        checkedAt: '2026-08-03T00:59:00.000Z',
        total,
        input: total,
        output: 0
      }))
    })
  );

  expect(view.providers[0]?.topSessions).toEqual([
    { id: 'ses_topusage0002', name: 'Second', total: 40, input: 40, output: 0 },
    { id: 'ses_topusage0004', name: 'Fourth', total: 30, input: 30, output: 0 },
    { id: 'ses_topusage0003', name: 'Third', total: 20, input: 20, output: 0 }
  ]);
});
