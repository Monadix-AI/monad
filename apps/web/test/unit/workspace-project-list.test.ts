import type { ExternalAgentSessionView, WorkplaceProject } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildWorkspaceProjects } from '../../lib/workspace-sessions.ts';

const project = (id: string, title: string): WorkplaceProject =>
  ({
    id,
    title,
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    origin: { surface: 'web', client: 'workplace', transport: 'http', writableBy: ['http'], branchableBy: ['http'] },
    cwd: undefined,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  }) as WorkplaceProject;

test('workspace project list keeps duplicate project names as separate projects', () => {
  expect(buildWorkspaceProjects([project('prj_first', 'demo'), project('prj_second', 'demo')])).toEqual([
    { id: 'prj_first', name: 'demo', cwd: undefined, hasRunningAgent: false, pinned: false, unreadCount: 0 },
    { id: 'prj_second', name: 'demo', cwd: undefined, hasRunningAgent: false, pinned: false, unreadCount: 0 }
  ]);
});

const externalAgentSession = (
  id: string,
  transcriptTargetId: string,
  overrides: Partial<ExternalAgentSessionView> = {}
): ExternalAgentSessionView =>
  ({
    id,
    transcriptTargetId,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/demo',
    launchMode: 'pty',
    approvalOwnership: 'provider-owned',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    pendingApprovalCount: 0,
    state: 'running',
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    exitedAt: null,
    ...overrides
  }) as ExternalAgentSessionView;

test('workspace project list summarizes live runtime and unread native cli messages', () => {
  expect(
    buildWorkspaceProjects([project('prj_active', 'active')], {
      liveExternalAgentSessions: [
        externalAgentSession('exa_one', 'prj_active', {
          lastDeliveredSeq: 6,
          lastVisibleSeq: 4,
          pendingApprovalCount: 1
        })
      ]
    })
  ).toEqual([
    {
      id: 'prj_active',
      name: 'active',
      cwd: undefined,
      hasRunningAgent: true,
      pinned: false,
      unreadCount: 3
    }
  ]);
});

test('workspace project list keeps unread messages from stopped native cli sessions without showing runtime active', () => {
  expect(
    buildWorkspaceProjects([project('prj_stopped', 'stopped')], {
      externalAgentSessions: [
        externalAgentSession('exa_stopped', 'prj_stopped', {
          lastDeliveredSeq: 8,
          lastVisibleSeq: 5,
          state: 'stopped'
        })
      ]
    })
  ).toEqual([
    {
      id: 'prj_stopped',
      name: 'stopped',
      cwd: undefined,
      hasRunningAgent: false,
      pinned: false,
      unreadCount: 3
    }
  ]);
});

test('workspace project list keeps pinned projects first without changing order inside groups', () => {
  expect(
    buildWorkspaceProjects(
      [project('prj_first', 'first'), project('prj_second', 'second'), project('prj_third', 'third')],
      { pinnedProjectIds: new Set(['prj_third', 'prj_second']) }
    ).map((item) => ({ id: item.id, pinned: item.pinned }))
  ).toEqual([
    { id: 'prj_second', pinned: true },
    { id: 'prj_third', pinned: true },
    { id: 'prj_first', pinned: false }
  ]);
});
