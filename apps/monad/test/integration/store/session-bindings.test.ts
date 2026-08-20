import type { ProjectMember, Session, SessionBinding, WorkplaceProject } from '@monad/protocol';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '#/store/db/index.ts';

const now = '2026-07-27T07:00:00.000Z';
const later = '2026-07-27T08:00:00.000Z';
const project: WorkplaceProject = {
  id: 'prj_binding00000',
  title: 'Bindings',
  state: 'active',
  archived: false,
  memberTemplates: [],
  createdAt: now,
  updatedAt: now
};
const member: ProjectMember = {
  id: 'pmem_reviewer',
  projectId: project.id,
  profileId: 'codex',
  type: 'mesh-agent',
  displayName: 'Reviewer',
  customPrompt: null,
  launchOverrides: {},
  workingDirectoryOverride: null,
  lifecycle: 'enabled',
  createdAt: now,
  updatedAt: now
};
const session = (id: Session['id'], projectId: Session['projectId']): Session => ({
  id,
  projectId,
  title: id,
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  activityAt: now,
  createdAt: now,
  updatedAt: now
});
const binding = (sessionId: Session['id']): SessionBinding => ({
  sessionId,
  projectMemberId: member.id,
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  currentNativeRuntimeSessionId: null,
  lifecycle: 'active',
  lastHealth: null,
  createdAt: now,
  updatedAt: now
});
const runtime = (
  id: MeshSessionRow['id'],
  sessionId: Session['id'],
  state: MeshSessionRow['state'] = 'running'
): MeshSessionRow => ({
  id,
  transcriptTargetId: sessionId,
  agentName: 'codex',
  provider: 'codex',
  workingPath: `/workspace/${sessionId}`,
  runtimeRole: 'managed-project-agent',
  agentRuntimeId: id,
  agentRuntimeTokenHash: null,
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  state,
  pid: 123,
  providerSessionRef: null,
  outputSnapshot: '',
  exitCode: null,
  startedAt: now,
  updatedAt: now,
  exitedAt: null
});

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
  store.insertWorkplaceProject(project);
  store.insertProjectMember(member);
  store.insertSession(session('ses_binding00001', project.id));
  store.insertSession(session('ses_binding00002', project.id));
});

afterEach(() => store.close());

test('one member keeps independent monotonic cursors and replaceable runtimes in two sessions', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.insertSessionBinding(binding('ses_binding00002'));

  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 12, later);
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 8, later);
  store.advanceSessionBindingVisibleCursor('ses_binding00001', member.id, 10, later);
  store.advanceSessionBindingVisibleCursor('ses_binding00001', member.id, 7, later);
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });

  store.advanceSessionBindingDeliveredCursor('ses_binding00002', member.id, 4, later);
  store.advanceSessionBindingVisibleCursor('ses_binding00002', member.id, 4, later);
  store.upsertMeshSession(runtime('mesh_binding00002', 'ses_binding00002', 'starting'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00002',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00002',
    updatedAt: later
  });

  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001'),
    updatedAt: '2026-07-27T09:00:00.000Z'
  });
  store.upsertMeshSession(runtime('mesh_binding00003', 'ses_binding00001', 'starting'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00003',
    updatedAt: '2026-07-27T09:00:00.000Z'
  });

  expect({
    bindings: store.listProjectMemberBindings(project.id, member.id),
    runtimes: ['mesh_binding00001', 'mesh_binding00002', 'mesh_binding00003'].map((id) => ({
      id,
      projectMemberId: store.getMeshSession(id)?.projectMemberId
    }))
  }).toEqual({
    bindings: [
      {
        sessionId: 'ses_binding00001',
        projectMemberId: member.id,
        lastDeliveredSeq: 12,
        lastVisibleSeq: 10,
        currentNativeRuntimeSessionId: 'mesh_binding00003',
        lifecycle: 'active',
        lastHealth: 'starting',
        createdAt: now,
        updatedAt: '2026-07-27T09:00:00.000Z'
      },
      {
        sessionId: 'ses_binding00002',
        projectMemberId: member.id,
        lastDeliveredSeq: 4,
        lastVisibleSeq: 4,
        currentNativeRuntimeSessionId: 'mesh_binding00002',
        lifecycle: 'active',
        lastHealth: 'starting',
        createdAt: now,
        updatedAt: later
      }
    ],
    runtimes: [
      { id: 'mesh_binding00001', projectMemberId: member.id },
      { id: 'mesh_binding00002', projectMemberId: member.id },
      { id: 'mesh_binding00003', projectMemberId: member.id }
    ]
  });
});

test('project-scoped binding lookup does not merge the same member id from another project', () => {
  const otherProject: WorkplaceProject = { ...project, id: 'prj_binding00002', title: 'Other' };
  store.insertWorkplaceProject(otherProject);
  store.insertProjectMember({ ...member, projectId: otherProject.id, displayName: 'Other reviewer' });
  store.insertSession(session('ses_binding00003', otherProject.id));
  store.insertSessionBinding(binding('ses_binding00001'));
  store.insertSessionBinding(binding('ses_binding00003'));

  expect(store.listProjectMemberBindings(project.id, member.id)).toEqual([binding('ses_binding00001')]);
  expect(store.listProjectMemberBindings(otherProject.id, member.id)).toEqual([binding('ses_binding00003')]);
});

test('runtime replacement rejects a different session and leaves both pointers unchanged', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00002', 'ses_binding00002'));

  expect(() =>
    store.replaceSessionBindingRuntime({
      sessionId: 'ses_binding00001',
      projectMemberId: member.id,
      currentNativeRuntimeSessionId: 'mesh_binding00002',
      updatedAt: later
    })
  ).toThrow('Native runtime session mesh_binding00002 does not belong to ses_binding00001');
  expect({
    binding: store.getSessionBinding('ses_binding00001', member.id),
    runtimeProjectMemberId: store.getMeshSession('mesh_binding00002')?.projectMemberId
  }).toEqual({
    binding: binding('ses_binding00001'),
    runtimeProjectMemberId: null
  });
});

test('binding creation rejects sessions without a member in the same project', () => {
  const otherProject: WorkplaceProject = { ...project, id: 'prj_binding00002', title: 'Other' };
  store.insertWorkplaceProject(otherProject);
  store.insertSession(session('ses_binding00003', otherProject.id));
  store.insertSession(session('ses_binding00004', undefined));

  expect(() => store.insertSessionBinding(binding('ses_binding00003'))).toThrow(
    'Session binding requires a ProjectMember from the Session project'
  );
  expect(() =>
    store.insertSessionBinding({
      ...binding('ses_binding00001'),
      projectMemberId: 'pmem_missing'
    })
  ).toThrow('Session binding requires a ProjectMember from the Session project');
  expect(() => store.insertSessionBinding(binding('ses_binding00004'))).toThrow(
    'Session binding requires a ProjectMember from the Session project'
  );
  expect([
    store.listSessionBindings('ses_binding00003'),
    store.listSessionBindings('ses_binding00001'),
    store.listSessionBindings('ses_binding00004')
  ]).toEqual([[], [], []]);
});

test('binding creation and runtime upsert cannot bypass atomic runtime ownership', () => {
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001'),
    projectMemberId: member.id
  } as MeshSessionRow);
  const bypassBinding: SessionBinding = {
    ...binding('ses_binding00001'),
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    lastHealth: 'running'
  };
  store.insertSessionBinding(bypassBinding);

  expect({
    binding: store.getSessionBinding('ses_binding00001', member.id),
    runtimeProjectMemberId: store.getMeshSession('mesh_binding00001')?.projectMemberId
  }).toEqual({
    binding: binding('ses_binding00001'),
    runtimeProjectMemberId: null
  });
});

test('cursor updates reject invalid values without changing durable delivery progress', () => {
  store.insertSessionBinding(binding('ses_binding00001'));

  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, invalid, later)).toThrow(
      'Session binding cursor must be a non-negative integer'
    );
    expect(() => store.advanceSessionBindingVisibleCursor('ses_binding00001', member.id, invalid, later)).toThrow(
      'Session binding cursor must be a non-negative integer'
    );
  }

  expect(store.getSessionBinding('ses_binding00001', member.id)).toEqual(binding('ses_binding00001'));
});

test('leaving a binding marks it left and clears its runtime while preserving cursor, identity, and peers', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.insertSessionBinding(binding('ses_binding00002'));
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 9, later);
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });

  const left = store.leaveSessionBinding('ses_binding00001', member.id, '2026-07-27T09:00:00.000Z');

  expect({ left, peer: store.getSessionBinding('ses_binding00002', member.id) }).toEqual({
    left: {
      sessionId: 'ses_binding00001',
      projectMemberId: member.id,
      lastDeliveredSeq: 9,
      lastVisibleSeq: 0,
      currentNativeRuntimeSessionId: null,
      lifecycle: 'left',
      lastHealth: 'running',
      createdAt: now,
      updatedAt: '2026-07-27T09:00:00.000Z'
    },
    peer: binding('ses_binding00002')
  });
});

test('a spawned member commit rolls back the legacy row and identity when the binding fails', () => {
  store.insertSession(session('ses_binding00009', undefined));

  expect(() =>
    store.createProjectSessionMember({
      legacyMember: {
        sessionId: 'ses_binding00009',
        memberId: 'pmem_spawn_rb',
        templateId: null,
        type: 'mesh-agent',
        data: { name: 'codex' },
        createdAt: now,
        updatedAt: now
      },
      member: { ...member, id: 'pmem_spawn_rb' },
      binding: { ...binding('ses_binding00009'), projectMemberId: 'pmem_spawn_rb' }
    })
  ).toThrow('Session binding requires a ProjectMember from the Session project');

  expect({
    legacy: store.getSessionMember('ses_binding00009', 'pmem_spawn_rb'),
    identity: store.getProjectMember(project.id, 'pmem_spawn_rb'),
    binding: store.getSessionBinding('ses_binding00009', 'pmem_spawn_rb')
  }).toEqual({ legacy: null, identity: null, binding: null });
});

function seedRestartMember(): void {
  store.insertSessionMember({
    sessionId: 'ses_binding00001',
    memberId: member.id,
    templateId: 'tmpl_reviewer',
    type: 'mesh-agent',
    data: { name: 'codex' },
    createdAt: now,
    updatedAt: now
  });
  store.updateSessionMember('ses_binding00001', member.id, { meshSessionId: 'mesh_binding00001', updatedAt: now });
  store.insertSessionBinding(binding('ses_binding00001'));
}

test('restart recovery (real boot order) backfills ownership, catches the cursor up, and clears the current runtime', () => {
  seedRestartMember();
  // The old daemon left a live runtime with real progress linked as the binding's current.
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
    lastDeliveredSeq: 7,
    lastVisibleSeq: 5
  });
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: now
  });

  // Real boot order: the orphan reconcile stamps the runtime terminal FIRST, then binding recovery runs.
  store.reconcileOrphanedMeshSessions(() => {});
  const stats = store.reconcileSessionBindingRuntimesAfterRestart();

  const after = store.getSessionBinding('ses_binding00001', member.id);
  if (!after) throw new Error('expected a recovered binding');
  const runtimeRow = store.getMeshSession('mesh_binding00001');
  expect({
    stats,
    after,
    runtimeState: runtimeRow?.state,
    runtimeOwner: runtimeRow?.projectMemberId,
    runtimeExited: runtimeRow?.exitedAt !== null
  }).toEqual({
    stats: { recovered: 1, skipped: 0, conflicts: 0 },
    after: {
      ...binding('ses_binding00001'),
      lastDeliveredSeq: 7,
      lastVisibleSeq: 5,
      currentNativeRuntimeSessionId: null,
      // The last observed health is preserved from the (now terminal) runtime, not forgotten.
      lastHealth: 'stopped',
      updatedAt: after.updatedAt
    },
    runtimeState: 'stopped',
    runtimeOwner: member.id,
    runtimeExited: true
  });

  // A second boot is a true no-op: the binding and the runtime are byte-for-byte unchanged.
  const runtimeAfterFirst = store.getMeshSession('mesh_binding00001');
  store.reconcileOrphanedMeshSessions(() => {});
  const stats2 = store.reconcileSessionBindingRuntimesAfterRestart();
  expect({
    stats2,
    binding: store.getSessionBinding('ses_binding00001', member.id),
    runtime: store.getMeshSession('mesh_binding00001')
  }).toEqual({ stats2: { recovered: 0, skipped: 0, conflicts: 0 }, binding: after, runtime: runtimeAfterFirst });
});

test('restart recovery never rewinds a binding cursor below the runtime watermark', () => {
  seedRestartMember();
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 20, later);
  store.advanceSessionBindingVisibleCursor('ses_binding00001', member.id, 18, later);
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
    lastDeliveredSeq: 7,
    lastVisibleSeq: 5
  });

  store.reconcileOrphanedMeshSessions(() => {});
  store.reconcileSessionBindingRuntimesAfterRestart();

  const after = store.getSessionBinding('ses_binding00001', member.id);
  expect({
    lastDeliveredSeq: after?.lastDeliveredSeq,
    lastVisibleSeq: after?.lastVisibleSeq,
    currentNativeRuntimeSessionId: after?.currentNativeRuntimeSessionId,
    lastHealth: after?.lastHealth,
    runtimeOwner: store.getMeshSession('mesh_binding00001')?.projectMemberId
  }).toEqual({
    lastDeliveredSeq: 20,
    lastVisibleSeq: 18,
    currentNativeRuntimeSessionId: null,
    lastHealth: 'stopped',
    runtimeOwner: member.id
  });
});

test('restart recovery catches a binding up to a legacy mesh cursor that is ahead of it (pre-freeze drift)', () => {
  // Pre-S2b data: the legacy mesh cursor advanced past the binding cursor. Before reads flip to the
  // binding watermark, restart recovery MAX-merges the mesh cursor into the binding so nothing is lost.
  seedRestartMember();
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 5, later);
  store.advanceSessionBindingVisibleCursor('ses_binding00001', member.id, 3, later);
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
    lastDeliveredSeq: 12,
    lastVisibleSeq: 9
  });

  store.reconcileOrphanedMeshSessions(() => {});
  const stats = store.reconcileSessionBindingRuntimesAfterRestart();

  const after = store.getSessionBinding('ses_binding00001', member.id);
  expect({
    stats,
    lastDeliveredSeq: after?.lastDeliveredSeq,
    lastVisibleSeq: after?.lastVisibleSeq,
    currentNativeRuntimeSessionId: after?.currentNativeRuntimeSessionId,
    runtimeOwner: store.getMeshSession('mesh_binding00001')?.projectMemberId
  }).toEqual({
    stats: { recovered: 1, skipped: 0, conflicts: 0 },
    lastDeliveredSeq: 12,
    lastVisibleSeq: 9,
    currentNativeRuntimeSessionId: null,
    runtimeOwner: member.id
  });
});

test('a real restart (reopen a file-backed store) recovers runtime ownership through the boot reconcile order', () => {
  const dbPath = join(tmpdir(), `monad-restart-recovery-${process.hrtime.bigint()}.sqlite`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  };
  try {
    const first = createStore({ path: dbPath });
    first.insertWorkplaceProject(project);
    first.insertProjectMember(member);
    first.insertSession(session('ses_binding00001', project.id));
    first.insertSessionMember({
      sessionId: 'ses_binding00001',
      memberId: member.id,
      templateId: 'tmpl_reviewer',
      type: 'mesh-agent',
      data: { name: 'codex' },
      createdAt: now,
      updatedAt: now
    });
    first.updateSessionMember('ses_binding00001', member.id, { meshSessionId: 'mesh_binding00001', updatedAt: now });
    first.insertSessionBinding(binding('ses_binding00001'));
    first.upsertMeshSession({
      ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
      lastDeliveredSeq: 11,
      lastVisibleSeq: 9
    });
    first.replaceSessionBindingRuntime({
      sessionId: 'ses_binding00001',
      projectMemberId: member.id,
      currentNativeRuntimeSessionId: 'mesh_binding00001',
      updatedAt: now
    });
    first.close();

    // First restart: reopen the durable file (runtime persisted as still 'running'), run the boot order.
    const rebooted = createStore({ path: dbPath });
    let recoveredBinding: ReturnType<typeof rebooted.getSessionBinding>;
    let recoveredRuntime: ReturnType<typeof rebooted.getMeshSession>;
    try {
      expect(rebooted.getMeshSession('mesh_binding00001')?.state).toBe('running');
      rebooted.reconcileOrphanedMeshSessions(() => {});
      const stats = rebooted.reconcileSessionBindingRuntimesAfterRestart();
      recoveredBinding = rebooted.getSessionBinding('ses_binding00001', member.id);
      recoveredRuntime = rebooted.getMeshSession('mesh_binding00001');
      expect({
        stats,
        current: recoveredBinding?.currentNativeRuntimeSessionId,
        cursor: [recoveredBinding?.lastDeliveredSeq, recoveredBinding?.lastVisibleSeq],
        lastHealth: recoveredBinding?.lastHealth,
        owner: recoveredRuntime?.projectMemberId,
        runtimeState: recoveredRuntime?.state
      }).toEqual({
        stats: { recovered: 1, skipped: 0, conflicts: 0 },
        current: null,
        cursor: [11, 9],
        lastHealth: 'stopped',
        owner: member.id,
        runtimeState: 'stopped'
      });
    } finally {
      rebooted.close();
    }

    // Second restart: the already-converged state must recover nothing and stay byte-for-byte equal.
    const rebootedAgain = createStore({ path: dbPath });
    try {
      rebootedAgain.reconcileOrphanedMeshSessions(() => {});
      const stats2 = rebootedAgain.reconcileSessionBindingRuntimesAfterRestart();
      expect({
        stats2,
        binding: rebootedAgain.getSessionBinding('ses_binding00001', member.id),
        runtime: rebootedAgain.getMeshSession('mesh_binding00001')
      }).toEqual({
        stats2: { recovered: 0, skipped: 0, conflicts: 0 },
        binding: recoveredBinding,
        runtime: recoveredRuntime
      });
    } finally {
      rebootedAgain.close();
    }
  } finally {
    cleanup();
  }
});

test('restart recovery recovers a left binding without reviving it', () => {
  seedRestartMember();
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 9, later);
  store.leaveSessionBinding('ses_binding00001', member.id, later);
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
    lastDeliveredSeq: 30,
    lastVisibleSeq: 30
  });

  store.reconcileOrphanedMeshSessions(() => {});
  const stats = store.reconcileSessionBindingRuntimesAfterRestart();

  const after = store.getSessionBinding('ses_binding00001', member.id);
  if (!after) throw new Error('expected the left binding to survive');
  // The runtime's ownership is backfilled and the cursor catches up (so a future explicit rejoin never
  // re-delivers consumed messages), yet lifecycle stays 'left' and current stays null — no revival.
  expect({ stats, after, owner: store.getMeshSession('mesh_binding00001')?.projectMemberId }).toEqual({
    stats: { recovered: 1, skipped: 0, conflicts: 0 },
    after: {
      ...binding('ses_binding00001'),
      lifecycle: 'left',
      lastDeliveredSeq: 30,
      lastVisibleSeq: 30,
      currentNativeRuntimeSessionId: null,
      lastHealth: 'stopped',
      updatedAt: after.updatedAt
    },
    owner: member.id
  });
});

test('restart recovery trusts the durable owner over a mismatched legacy row: conflict + owner converged, legacy untouched', () => {
  const otherMember: ProjectMember = { ...member, id: 'pmem_other', displayName: 'Other' };
  store.insertProjectMember(otherMember);
  // The runtime's legacy SessionMember row links it to `member`, but its persisted project_member_id was
  // already claimed by `otherMember`. The durable owner is authoritative: the mismatch is an observable
  // conflict, but otherMember's binding is still converged; member's (legacy claimant) binding is untouched.
  store.insertSessionMember({
    sessionId: 'ses_binding00001',
    memberId: member.id,
    templateId: 'tmpl_reviewer',
    type: 'mesh-agent',
    data: { name: 'codex' },
    createdAt: now,
    updatedAt: now
  });
  store.updateSessionMember('ses_binding00001', member.id, { meshSessionId: 'mesh_binding00001', updatedAt: now });
  store.insertSessionBinding(binding('ses_binding00001'));
  store.insertSessionBinding({ ...binding('ses_binding00001'), projectMemberId: otherMember.id });
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
    lastDeliveredSeq: 7,
    lastVisibleSeq: 5
  });
  // otherMember claims the runtime first, so its binding points at the (then live) runtime.
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: otherMember.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });
  const legacyClaimantBinding = store.getSessionBinding('ses_binding00001', member.id);

  store.reconcileOrphanedMeshSessions(() => {});
  const stats = store.reconcileSessionBindingRuntimesAfterRestart();

  const durableOwnerBinding = store.getSessionBinding('ses_binding00001', otherMember.id);
  if (!durableOwnerBinding) throw new Error('expected the durable owner binding to survive');
  expect({
    stats,
    durableOwnerBinding,
    legacyClaimantBinding: store.getSessionBinding('ses_binding00001', member.id),
    runtimeOwner: store.getMeshSession('mesh_binding00001')?.projectMemberId
  }).toEqual({
    stats: { recovered: 1, skipped: 0, conflicts: 1 },
    // The durable owner's binding is converged: cursor caught to the runtime watermark, current cleared,
    // health advanced to the terminal state. No terminal runtime is left as anyone's current.
    durableOwnerBinding: {
      ...binding('ses_binding00001'),
      projectMemberId: otherMember.id,
      lastDeliveredSeq: 7,
      lastVisibleSeq: 5,
      currentNativeRuntimeSessionId: null,
      lastHealth: 'stopped',
      updatedAt: durableOwnerBinding.updatedAt
    },
    // The legacy claimant's binding is not the runtime's owner — it is left exactly as it was.
    legacyClaimantBinding,
    runtimeOwner: otherMember.id
  });
});

test('restart recovery heals a stale binding health from the authoritative runtime, then no-ops', () => {
  // Simulate the upgrade artifact: a prior recovery left the binding owner-correct, cursor caught, and
  // current cleared, but its lastHealth null (the old recovery forgot the terminal state). Ownership is
  // claimed through the sanctioned entrance, then the binding health is forced stale.
  seedRestartMember();
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'running'),
    lastDeliveredSeq: 7,
    lastVisibleSeq: 5
  });
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 7, later);
  store.advanceSessionBindingVisibleCursor('ses_binding00001', member.id, 5, later);
  store.reconcileOrphanedMeshSessions(() => {});
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: null,
    updatedAt: later
  });
  store.updateSessionBinding('ses_binding00001', member.id, { lastHealth: null, updatedAt: later });
  const beforeHeal = store.getSessionBinding('ses_binding00001', member.id);
  if (beforeHeal?.lastHealth !== null) throw new Error('fixture must start with a stale null health');

  store.reconcileOrphanedMeshSessions(() => {});
  const stats = store.reconcileSessionBindingRuntimesAfterRestart();

  const healed = store.getSessionBinding('ses_binding00001', member.id);
  if (!healed) throw new Error('expected the healed binding to survive');
  expect({ stats, healed }).toEqual({
    stats: { recovered: 1, skipped: 0, conflicts: 0 },
    healed: {
      ...beforeHeal,
      lastHealth: 'stopped',
      updatedAt: healed.updatedAt
    }
  });

  // Health now matches the authoritative runtime: a second boot recovers nothing and is byte-for-byte equal.
  store.reconcileOrphanedMeshSessions(() => {});
  const stats2 = store.reconcileSessionBindingRuntimesAfterRestart();
  expect({ stats2, binding: store.getSessionBinding('ses_binding00001', member.id) }).toEqual({
    stats2: { recovered: 0, skipped: 0, conflicts: 0 },
    binding: healed
  });
});

test('session and project deletion remove bindings and project member identities', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.insertSessionBinding(binding('ses_binding00002'));

  expect(store.deleteSession('ses_binding00001')).toBe(true);
  expect(store.getSessionBinding('ses_binding00001', member.id)).toBeNull();
  expect(store.getProjectMember(project.id, member.id)).toEqual(member);

  expect(store.deleteWorkplaceProject(project.id)).toBe(true);
  expect({
    binding: store.getSessionBinding('ses_binding00002', member.id),
    member: store.getProjectMember(project.id, member.id)
  }).toEqual({ binding: null, member: null });
});

test('pruning retains a terminal runtime while a binding points to it', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00001', 'stopped'),
    exitedAt: '2000-01-01T00:00:00.000Z'
  });
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });

  expect(store.pruneExitedMeshSessions(0)).toBe(0);
  expect(store.getMeshSession('mesh_binding00001')?.projectMemberId).toBe(member.id);

  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: null,
    updatedAt: later
  });
  expect(store.pruneExitedMeshSessions(0)).toBe(1);
  expect(store.getMeshSession('mesh_binding00001')).toBeNull();
});

test('runtime upsert cannot move an owned runtime away from its authoritative binding', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });

  store.upsertMeshSession({
    ...runtime('mesh_binding00001', 'ses_binding00002'),
    updatedAt: '2026-07-27T09:00:00.000Z'
  });

  expect({
    binding: store.getSessionBinding('ses_binding00001', member.id),
    runtime: store.getMeshSession('mesh_binding00001')
  }).toEqual({
    binding: {
      ...binding('ses_binding00001'),
      currentNativeRuntimeSessionId: 'mesh_binding00001',
      lastHealth: 'running',
      updatedAt: later
    },
    runtime: {
      ...runtime('mesh_binding00001', 'ses_binding00001'),
      projectMemberId: member.id,
      updatedAt: '2026-07-27T09:00:00.000Z'
    }
  });
});

const settleAt = '2026-07-27T09:00:00.000Z';

test('settling a terminal runtime clears current and records terminal health, preserving cursor and identity', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.advanceSessionBindingDeliveredCursor('ses_binding00001', member.id, 7, later);
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });

  const settled = store.settleTerminalSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    terminatingRuntimeId: 'mesh_binding00001',
    terminalState: 'exited',
    at: settleAt
  });

  expect(settled).toEqual({
    ...binding('ses_binding00001'),
    lastDeliveredSeq: 7,
    currentNativeRuntimeSessionId: null,
    lastHealth: 'exited',
    updatedAt: settleAt
  });
});

test('a superseded runtime settling after replacement is a CAS no-op and leaves the new current intact', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00002', 'ses_binding00001', 'starting'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00002',
    updatedAt: later
  });

  // The OLD runtime exits late; the binding already points at the NEW runtime.
  const settled = store.settleTerminalSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    terminatingRuntimeId: 'mesh_binding00001',
    terminalState: 'failed',
    at: settleAt
  });

  expect(settled).toEqual({
    ...binding('ses_binding00001'),
    currentNativeRuntimeSessionId: 'mesh_binding00002',
    lastHealth: 'starting',
    updatedAt: later
  });
});

test('a repeated terminal settle for the same runtime is idempotent and does not overwrite the recorded health', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });

  const first = store.settleTerminalSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    terminatingRuntimeId: 'mesh_binding00001',
    terminalState: 'stopped',
    at: settleAt
  });
  // A second callback for the same runtime carries a different terminal state; the CAS no longer matches.
  const second = store.settleTerminalSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    terminatingRuntimeId: 'mesh_binding00001',
    terminalState: 'exited',
    at: '2026-07-27T10:00:00.000Z'
  });

  const expected: SessionBinding = {
    ...binding('ses_binding00001'),
    currentNativeRuntimeSessionId: null,
    lastHealth: 'stopped',
    updatedAt: settleAt
  };
  expect({ first, second }).toEqual({ first: expected, second: expected });
});

test('settling a terminal runtime leaves a left binding untouched (current already cleared)', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });
  store.leaveSessionBinding('ses_binding00001', member.id, later);

  const settled = store.settleTerminalSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    terminatingRuntimeId: 'mesh_binding00001',
    terminalState: 'stopped',
    at: settleAt
  });

  expect(settled).toEqual({
    ...binding('ses_binding00001'),
    lifecycle: 'left',
    currentNativeRuntimeSessionId: null,
    lastHealth: 'running',
    updatedAt: later
  });
});

test('settling a terminal runtime on a suspended binding clears current and health but keeps the suspended lifecycle', () => {
  store.insertSessionBinding(binding('ses_binding00001'));
  store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
  store.replaceSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: 'mesh_binding00001',
    updatedAt: later
  });
  store.updateSessionBinding('ses_binding00001', member.id, { lifecycle: 'suspended', updatedAt: later });

  const settled = store.settleTerminalSessionBindingRuntime({
    sessionId: 'ses_binding00001',
    projectMemberId: member.id,
    terminatingRuntimeId: 'mesh_binding00001',
    terminalState: 'failed',
    at: settleAt
  });

  expect(settled).toEqual({
    ...binding('ses_binding00001'),
    lifecycle: 'suspended',
    currentNativeRuntimeSessionId: null,
    lastHealth: 'failed',
    updatedAt: settleAt
  });
});

// Two runtimes for one binding both reach terminal (a supersede race). SQLite serializes writes and the
// CAS lives in the WHERE (a single conditional UPDATE, not a read-check-write), so whichever order the two
// terminal callbacks arrive, only the binding's current runtime (NEW) can settle and the superseded one is
// a no-op — no TOCTOU window.
for (const order of ['old-then-new', 'new-then-old'] as const) {
  test(`racing terminal settles resolve to the current runtime regardless of callback order (${order})`, () => {
    store.insertSessionBinding(binding('ses_binding00001'));
    store.upsertMeshSession(runtime('mesh_binding00001', 'ses_binding00001'));
    store.upsertMeshSession(runtime('mesh_binding00002', 'ses_binding00001', 'starting'));
    store.replaceSessionBindingRuntime({
      sessionId: 'ses_binding00001',
      projectMemberId: member.id,
      currentNativeRuntimeSessionId: 'mesh_binding00001',
      updatedAt: later
    });
    store.replaceSessionBindingRuntime({
      sessionId: 'ses_binding00001',
      projectMemberId: member.id,
      currentNativeRuntimeSessionId: 'mesh_binding00002',
      updatedAt: later
    });

    const settleOld = () =>
      store.settleTerminalSessionBindingRuntime({
        sessionId: 'ses_binding00001',
        projectMemberId: member.id,
        terminatingRuntimeId: 'mesh_binding00001',
        terminalState: 'failed',
        at: settleAt
      });
    const settleNew = () =>
      store.settleTerminalSessionBindingRuntime({
        sessionId: 'ses_binding00001',
        projectMemberId: member.id,
        terminatingRuntimeId: 'mesh_binding00002',
        terminalState: 'stopped',
        at: settleAt
      });
    if (order === 'old-then-new') {
      settleOld();
      settleNew();
    } else {
      settleNew();
      settleOld();
    }

    expect(store.getSessionBinding('ses_binding00001', member.id)).toEqual({
      ...binding('ses_binding00001'),
      currentNativeRuntimeSessionId: null,
      // NEW (the current runtime) wins; OLD's 'failed' never lands.
      lastHealth: 'stopped',
      updatedAt: settleAt
    });
  });
}
