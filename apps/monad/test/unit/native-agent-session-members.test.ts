import type { Store } from '#/store/db/index.ts';

import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createNativeAgentSessionMembersService } from '#/services/native-agent/session-members.ts';

const SESSION = 'ses_roster00000001';
const PROJECT = 'prj_roster0000001';
const AT = '2026-07-20T00:00:00.000Z';

type BindingInput = {
  projectMemberId: string;
  lifecycle: 'active' | 'suspended' | 'left';
  currentNativeRuntimeSessionId: string | null;
};
type RuntimeInput = {
  id: string;
  transcriptTargetId?: string;
  runtimeRole?: string;
  projectMemberId?: string | null;
  state?: string;
};

function member(id: string, displayName: string, profileId = id) {
  return {
    id,
    projectId: PROJECT,
    profileId,
    type: 'mesh-agent',
    displayName,
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: AT,
    updatedAt: AT
  };
}

function runtime(input: RuntimeInput) {
  return {
    id: input.id,
    transcriptTargetId: input.transcriptTargetId ?? SESSION,
    runtimeRole: input.runtimeRole ?? 'managed-project-agent',
    projectMemberId: input.projectMemberId ?? null,
    state: input.state ?? 'running'
  };
}

function makeStore(input: {
  bindings: BindingInput[];
  members: Record<string, ReturnType<typeof member> | undefined>;
  runtimes?: Record<string, ReturnType<typeof runtime> | undefined>;
}): Store {
  return {
    getSession: () => ({ id: SESSION, projectId: PROJECT }),
    listSessionBindings: () =>
      input.bindings.map((b) => ({
        sessionId: SESSION,
        lastDeliveredSeq: 0,
        lastVisibleSeq: 0,
        lastHealth: null,
        createdAt: AT,
        updatedAt: AT,
        ...b
      })),
    getProjectMember: (_projectId: string, memberId: string) => input.members[memberId],
    getMeshSession: (id: string) => input.runtimes?.[id] ?? null
  } as unknown as Store;
}

test('roster availability is the exact live runtime bound to each active member', async () => {
  const store = makeStore({
    bindings: [
      { projectMemberId: 'pmem_online', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_online00000' },
      { projectMemberId: 'pmem_terminal', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_terminal000' },
      { projectMemberId: 'pmem_dangling', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_dangling000' },
      { projectMemberId: 'pmem_wrongowner', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_wrongowner0' },
      { projectMemberId: 'pmem_wrongsess', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_wrongsess00' },
      { projectMemberId: 'pmem_nocurrent', lifecycle: 'active', currentNativeRuntimeSessionId: null },
      { projectMemberId: 'pmem_suspended', lifecycle: 'suspended', currentNativeRuntimeSessionId: 'mesh_online00000' },
      { projectMemberId: 'pmem_left', lifecycle: 'left', currentNativeRuntimeSessionId: 'mesh_online00000' }
    ],
    members: {
      pmem_online: member('pmem_online', 'Online'),
      pmem_terminal: member('pmem_terminal', 'Terminal'),
      pmem_dangling: member('pmem_dangling', 'Dangling'),
      pmem_wrongowner: member('pmem_wrongowner', 'Wrong owner'),
      pmem_wrongsess: member('pmem_wrongsess', 'Wrong session'),
      pmem_nocurrent: member('pmem_nocurrent', 'No current'),
      pmem_suspended: member('pmem_suspended', 'Suspended')
    },
    runtimes: {
      mesh_online00000: runtime({ id: 'mesh_online00000', projectMemberId: 'pmem_online', state: 'running' }),
      mesh_terminal000: runtime({ id: 'mesh_terminal000', projectMemberId: 'pmem_terminal', state: 'exited' }),
      // mesh_dangling000 intentionally absent
      mesh_wrongowner0: runtime({ id: 'mesh_wrongowner0', projectMemberId: 'pmem_someone_else', state: 'running' }),
      mesh_wrongsess00: runtime({
        id: 'mesh_wrongsess00',
        projectMemberId: 'pmem_wrongsess',
        transcriptTargetId: 'ses_other00000000',
        state: 'running'
      })
    }
  });
  const service = createNativeAgentSessionMembersService({ store });

  // Only pmem_online is online: its active binding points at a running, same-session, same-owner managed
  // runtime. A terminal/dangling/wrong-owner/wrong-session current id, a null current, and a
  // suspended/left binding are all offline (left is excluded from the roster entirely).
  expect(await service.list(SESSION, 'pmem_requester')).toEqual({
    members: [
      { id: 'pmem_online', displayName: 'Online', status: 'online' },
      { id: 'pmem_terminal', displayName: 'Terminal', status: 'offline' },
      { id: 'pmem_dangling', displayName: 'Dangling', status: 'offline' },
      { id: 'pmem_wrongowner', displayName: 'Wrong owner', status: 'offline' },
      { id: 'pmem_wrongsess', displayName: 'Wrong session', status: 'offline' },
      { id: 'pmem_nocurrent', displayName: 'No current', status: 'offline' },
      { id: 'pmem_suspended', displayName: 'Suspended', status: 'offline' }
    ]
  });
});

test('the roster requester excludes itself by projectMemberId', async () => {
  const store = makeStore({
    bindings: [
      { projectMemberId: 'pmem_self', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_self0000000' },
      { projectMemberId: 'pmem_other', lifecycle: 'active', currentNativeRuntimeSessionId: null }
    ],
    members: { pmem_self: member('pmem_self', 'Self'), pmem_other: member('pmem_other', 'Other') },
    runtimes: { mesh_self0000000: runtime({ id: 'mesh_self0000000', projectMemberId: 'pmem_self' }) }
  });
  const service = createNativeAgentSessionMembersService({ store });

  expect(await service.list(SESSION, 'pmem_self')).toEqual({
    members: [{ id: 'pmem_other', displayName: 'Other', status: 'offline' }]
  });
});

test('the roster fails closed when an active binding has no ProjectMember', async () => {
  const store = makeStore({
    bindings: [{ projectMemberId: 'pmem_orphan', lifecycle: 'active', currentNativeRuntimeSessionId: null }],
    members: {}
  });
  const service = createNativeAgentSessionMembersService({ store });

  let thrown: unknown;
  try {
    await service.list(SESSION, 'pmem_requester');
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HandlerError);
  expect((thrown as HandlerError).kind).toBe('internal');
});

test('two members from one Profile track their own runtime bindings independently', async () => {
  const store = makeStore({
    bindings: [
      { projectMemberId: 'pmem_a', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_a0000000000' },
      { projectMemberId: 'pmem_b', lifecycle: 'active', currentNativeRuntimeSessionId: 'mesh_b0000000000' }
    ],
    members: {
      pmem_a: member('pmem_a', 'Reviewer A', 'tpl_codex'),
      pmem_b: member('pmem_b', 'Reviewer B', 'tpl_codex')
    },
    runtimes: {
      mesh_a0000000000: runtime({ id: 'mesh_a0000000000', projectMemberId: 'pmem_a', state: 'running' }),
      mesh_b0000000000: runtime({ id: 'mesh_b0000000000', projectMemberId: 'pmem_b', state: 'exited' })
    }
  });
  const service = createNativeAgentSessionMembersService({ store });

  expect(await service.list(SESSION, 'pmem_requester')).toEqual({
    members: [
      { id: 'pmem_a', displayName: 'Reviewer A', status: 'online' },
      { id: 'pmem_b', displayName: 'Reviewer B', status: 'offline' }
    ]
  });
});

test('the roster resolves an internal Monad profile name to its display name and provider icon', async () => {
  const internalName = 'monad--agt_eAmWnO0FDkBJ';
  const store = makeStore({
    bindings: [{ projectMemberId: 'pmem_monad', lifecycle: 'active', currentNativeRuntimeSessionId: null }],
    members: { pmem_monad: member('pmem_monad', internalName, internalName) }
  });
  const service = createNativeAgentSessionMembersService({
    store,
    meshAgents: () => [
      {
        name: internalName,
        displayName: 'Researcher',
        provider: 'monad',
        productIcon: 'monad',
        command: 'monad',
        enabled: true,
        allowAutopilot: false,
        approvalOwnership: 'provider-owned'
      }
    ]
  });

  expect(await service.list(SESSION, 'pmem_requester')).toEqual({
    members: [
      {
        id: 'pmem_monad',
        displayName: 'Researcher',
        provider: 'monad',
        productIcon: 'monad',
        status: 'offline'
      }
    ]
  });
});
