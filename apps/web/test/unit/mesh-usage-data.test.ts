import { expect, test } from 'bun:test';
import { meshUsageOverviewResponseSchema } from '@monad/protocol';

import { buildMeshUsageView } from '../../src/features/studio/mesh-usage-data';

test('Mesh usage view aggregates persisted snapshots by provider and project', () => {
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
          projectId: 'prj_projusage001',
          agentName: 'codex',
          provider: 'codex',
          checkedAt: '2026-08-03T00:57:00.000Z',
          total: 100,
          input: 70,
          output: 30
        },
        {
          meshSessionId: 'mesh_usageview002',
          sessionId: 'ses_sessusage002',
          projectId: 'prj_projusage001',
          agentName: 'claude',
          provider: 'claude-code',
          checkedAt: '2026-08-03T00:56:00.000Z',
          total: 50,
          input: 40,
          output: 10
        },
        {
          meshSessionId: 'mesh_usageview003',
          sessionId: 'ses_sessusage003',
          projectId: 'prj_projusage002',
          agentName: 'codex',
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
    agents: 2,
    sessions: 3,
    totals: { total: 175, input: 125, output: 50 },
    providers: [
      {
        provider: 'codex',
        agentNames: ['codex'],
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
        total: 125,
        input: 85,
        output: 40
      },
      {
        provider: 'claude-code',
        agentNames: ['claude'],
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
        total: 50,
        input: 40,
        output: 10
      }
    ],
    projects: [
      {
        projectId: 'prj_projusage001',
        providerNames: ['claude-code', 'codex'],
        agentNames: ['claude', 'codex'],
        sessionCount: 2,
        total: 150,
        input: 110,
        output: 40
      },
      {
        projectId: 'prj_projusage002',
        providerNames: ['codex'],
        agentNames: ['codex'],
        sessionCount: 1,
        total: 25,
        input: 15,
        output: 10
      }
    ]
  });
});
