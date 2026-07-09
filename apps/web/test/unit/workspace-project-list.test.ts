import type { ExternalAgentSessionView, Session, WorkplaceProject } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildWorkspaceProjects } from '../../lib/workspace-sessions.ts';

const project = (id: string, title: string): WorkplaceProject =>
  ({
    id,
    title,
    ownerPrincipalId: 'prn_test00000000',
    state: 'active',
    archived: false,
    origin: { surface: 'web', client: 'workplace', transport: 'http', writableBy: ['http'], branchableBy: ['http'] },
    cwd: undefined,
    memberTemplates: [],
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  }) as WorkplaceProject;

test('workspace project list keeps duplicate project names as separate projects', () => {
  expect(buildWorkspaceProjects([project('prj_ACTIVE000000', 'demo'), project('prj_STOPPED00000', 'demo')])).toEqual([
    {
      id: 'prj_ACTIVE000000',
      name: 'demo',
      cwd: undefined,
      hasRunningAgent: false,
      pinned: false,
      sessions: [],
      unreadCount: 0
    },
    {
      id: 'prj_STOPPED00000',
      name: 'demo',
      cwd: undefined,
      hasRunningAgent: false,
      pinned: false,
      sessions: [],
      unreadCount: 0
    }
  ]);
});

const externalAgentSession = (
  id: string,
  sessionId: string,
  overrides: Partial<ExternalAgentSessionView> = {}
): ExternalAgentSessionView =>
  ({
    id,
    sessionId,
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
    buildWorkspaceProjects([project('prj_ACTIVE000000', 'active')], {
      sessions: [session('ses_ACTIVE000000', 'prj_ACTIVE000000', 'ses_ACTIVE000000', '2026-07-02T00:00:00.000Z')],
      liveExternalAgentSessions: [
        externalAgentSession('exa_ONE000000000', 'ses_ACTIVE000000', {
          lastDeliveredSeq: 6,
          lastVisibleSeq: 4,
          pendingApprovalCount: 1
        })
      ]
    })
  ).toEqual([
    {
      id: 'prj_ACTIVE000000',
      name: 'active',
      cwd: undefined,
      hasRunningAgent: true,
      pinned: false,
      sessions: [{ id: 'ses_ACTIVE000000', title: 'ses_ACTIVE000000' }],
      unreadCount: 3
    }
  ]);
});

test('workspace project list keeps unread messages from stopped native cli sessions without showing runtime active', () => {
  expect(
    buildWorkspaceProjects([project('prj_STOPPED00000', 'stopped')], {
      sessions: [session('ses_STOPPED00000', 'prj_STOPPED00000', 'ses_STOPPED00000', '2026-07-02T00:00:00.000Z')],
      externalAgentSessions: [
        externalAgentSession('exa_STOPPED00000', 'ses_STOPPED00000', {
          lastDeliveredSeq: 8,
          lastVisibleSeq: 5,
          state: 'stopped'
        })
      ]
    })
  ).toEqual([
    {
      id: 'prj_STOPPED00000',
      name: 'stopped',
      cwd: undefined,
      hasRunningAgent: false,
      pinned: false,
      sessions: [{ id: 'ses_STOPPED00000', title: 'ses_STOPPED00000' }],
      unreadCount: 3
    }
  ]);
});

test('workspace project list keeps pinned projects first without changing order inside groups', () => {
  expect(
    buildWorkspaceProjects(
      [
        project('prj_FIRST0000000', 'first'),
        project('prj_SECOND000000', 'second'),
        project('prj_THIRD0000000', 'third')
      ],
      { pinnedProjectIds: new Set(['prj_THIRD0000000', 'prj_SECOND000000']) }
    ).map((item) => ({ id: item.id, pinned: item.pinned }))
  ).toEqual([
    { id: 'prj_SECOND000000', pinned: true },
    { id: 'prj_THIRD0000000', pinned: true },
    { id: 'prj_FIRST0000000', pinned: false }
  ]);
});

function session(
  id: string,
  projectId: string,
  title: string,
  updatedAt: string
): Pick<Session, 'id' | 'projectId' | 'title' | 'updatedAt'> {
  return {
    id: id as Session['id'],
    projectId: projectId as Session['projectId'],
    title,
    updatedAt
  };
}

test('workspace project list nests project sessions by recent activity', () => {
  expect(
    buildWorkspaceProjects([project('prj_FIRST0000000', 'first'), project('prj_SECOND000000', 'second')], {
      sessions: [
        session('ses_OLD000000000', 'prj_FIRST0000000', 'old session', '2026-07-02T00:00:00.000Z'),
        session('ses_OTHER0000000', 'prj_SECOND000000', 'other session', '2026-07-03T00:00:00.000Z'),
        session('ses_NEW000000000', 'prj_FIRST0000000', 'new session', '2026-07-04T00:00:00.000Z')
      ]
    }).map((item) => ({ id: item.id, sessions: item.sessions }))
  ).toEqual([
    {
      id: 'prj_FIRST0000000',
      sessions: [
        { id: 'ses_NEW000000000', title: 'new session' },
        { id: 'ses_OLD000000000', title: 'old session' }
      ]
    },
    {
      id: 'prj_SECOND000000',
      sessions: [{ id: 'ses_OTHER0000000', title: 'other session' }]
    }
  ]);
});
