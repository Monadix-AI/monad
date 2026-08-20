import type { Database } from 'bun:sqlite';
import type { MeshSessionId, ProjectMember, Session, WorkplaceProject } from '@monad/protocol';
import type { MeshSessionUpsert } from '#/store/db/mesh-sessions.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';
import { MeshAgentDeliveryOwnershipError } from '#/store/db/mesh-agent-inbox.ts';

const now = '2026-07-28T00:00:00.000Z';
const RUNTIME_A = 'mesh_fence0000001' as MeshSessionId;
const RUNTIME_B = 'mesh_fence0000002' as MeshSessionId;
const RUNTIME_C = 'mesh_fence0000003' as MeshSessionId;
const project: WorkplaceProject = {
  id: 'prj_fence0000000',
  title: 'Fence',
  state: 'active',
  archived: false,
  memberTemplates: [],
  createdAt: now,
  updatedAt: now
};
const member: ProjectMember = {
  id: 'pmem_owner',
  projectId: project.id,
  profileId: 'codex',
  type: 'mesh-agent',
  displayName: 'Owner',
  customPrompt: null,
  launchOverrides: {},
  workingDirectoryOverride: null,
  lifecycle: 'enabled',
  createdAt: now,
  updatedAt: now
};
const session: Session = {
  id: 'ses_fence0000001',
  projectId: project.id,
  title: 'Fence',
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  activityAt: now,
  createdAt: now,
  updatedAt: now
};
const freshBinding = {
  sessionId: session.id,
  projectMemberId: member.id,
  lastDeliveredSeq: 0,
  lastVisibleSeq: 0,
  currentNativeRuntimeSessionId: null,
  lifecycle: 'active' as const,
  lastHealth: null,
  createdAt: now,
  updatedAt: now
};

function runtime(
  id: MeshSessionId,
  role: MeshSessionUpsert['runtimeRole'] = 'managed-project-agent'
): MeshSessionUpsert {
  return {
    id,
    transcriptTargetId: session.id,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/workspace',
    runtimeRole: role,
    agentRuntimeId: id,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: 123,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt: now,
    updatedAt: now,
    exitedAt: null
  };
}

function own(meshSessionId: MeshSessionId): void {
  store.replaceSessionBindingRuntime({
    sessionId: session.id,
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: meshSessionId,
    updatedAt: now
  });
}

const deliveryOf = (seq: number): `deliv_${string}` => `deliv_fenceitem00${seq}`;

function enqueueItemAt(meshSessionId: string, seq: number): void {
  store.enqueueMeshAgentInboxItem(meshSessionId, seq, { deliveryId: deliveryOf(seq) });
}

function itemStateOf(seq: number): string | null {
  return store.getNativeAgentDelivery(deliveryOf(seq))?.state ?? null;
}

// Inserts a message (rowid === seq on a fresh store) so list/count can JOIN it, then enqueues the item.
function seedItem(meshSessionId: string, seq: number): void {
  store.insertMessage(`msg_fencemsg000${seq}`, session.id, `msg ${seq}`, `2026-07-28T00:00:0${seq}.000Z`, 'user');
  enqueueItemAt(meshSessionId, seq);
}

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
  store.insertWorkplaceProject(project);
  store.insertProjectMember(member);
  store.insertSession(session);
  store.insertSessionBinding({
    sessionId: session.id,
    projectMemberId: member.id,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now
  });
});

afterEach(() => store.close());

test('an owned managed runtime advances the binding cursor and item state while the mesh cursor stays frozen', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  own(RUNTIME_A);
  enqueueItemAt(RUNTIME_A, 3);

  store.markMeshAgentInboxDelivered(RUNTIME_A, 7);
  store.markMeshAgentInboxVisible(RUNTIME_A, 5);

  const binding = store.getSessionBinding(session.id, member.id);
  const runtimeRow = store.getMeshSession(RUNTIME_A);
  expect({
    bindingDelivered: binding?.lastDeliveredSeq,
    bindingVisible: binding?.lastVisibleSeq,
    meshDelivered: runtimeRow?.lastDeliveredSeq,
    meshVisible: runtimeRow?.lastVisibleSeq,
    itemState: itemStateOf(3)
  }).toEqual({
    bindingDelivered: 7,
    bindingVisible: 5,
    // The legacy mesh cursor is frozen for a managed runtime — the binding is the single source of truth.
    meshDelivered: 0,
    meshVisible: 0,
    itemState: 'visible'
  });
});

test('consuming advances the binding visible cursor and marks the item consumed with the mesh cursor frozen', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  own(RUNTIME_A);
  enqueueItemAt(RUNTIME_A, 4);

  store.markMeshAgentInboxConsumed(RUNTIME_A, 9);

  const binding = store.getSessionBinding(session.id, member.id);
  expect({
    bindingVisible: binding?.lastVisibleSeq,
    meshVisible: store.getMeshSession(RUNTIME_A)?.lastVisibleSeq,
    itemState: itemStateOf(4)
  }).toEqual({ bindingVisible: 9, meshVisible: 0, itemState: 'consumed' });
});

test('an unowned managed runtime is an invariant failure that advances nothing', () => {
  store.upsertMeshSession(runtime(RUNTIME_B));
  enqueueItemAt(RUNTIME_B, 2);

  expect(() => store.markMeshAgentInboxDelivered(RUNTIME_B, 5)).toThrow(MeshAgentDeliveryOwnershipError);

  expect({
    binding: store.getSessionBinding(session.id, member.id),
    meshDelivered: store.getMeshSession(RUNTIME_B)?.lastDeliveredSeq,
    itemState: itemStateOf(2)
  }).toEqual({ binding: freshBinding, meshDelivered: 0, itemState: 'queued' });
});

test('a superseded runtime writing after the binding moved on is fenced off and advances nothing', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  store.upsertMeshSession(runtime(RUNTIME_B));
  // The member owned runtime A first, then a fresh runtime B became the binding's current attachment.
  own(RUNTIME_A);
  own(RUNTIME_B);
  enqueueItemAt(RUNTIME_A, 3);
  const bindingBefore = store.getSessionBinding(session.id, member.id);

  // The stale runtime A tries to deliver late; it is owned by the member but no longer its current runtime.
  const committed = store.markMeshAgentInboxDelivered(RUNTIME_A, 8);

  expect({
    committed,
    binding: store.getSessionBinding(session.id, member.id),
    staleMeshDelivered: store.getMeshSession(RUNTIME_A)?.lastDeliveredSeq,
    itemState: itemStateOf(3)
  }).toEqual({ committed: false, binding: bindingBefore, staleMeshDelivered: 0, itemState: 'queued' });
});

test('a non-active binding with a residual current pointer is fenced off and advances nothing', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  own(RUNTIME_A);
  // Defensive bad state: the binding was suspended but a stale current pointer was left behind.
  store.updateSessionBinding(session.id, member.id, { lifecycle: 'suspended', updatedAt: now });
  enqueueItemAt(RUNTIME_A, 3);
  const bindingBefore = store.getSessionBinding(session.id, member.id);

  const committed = store.markMeshAgentInboxDelivered(RUNTIME_A, 8);

  expect({
    committed,
    binding: store.getSessionBinding(session.id, member.id),
    meshDelivered: store.getMeshSession(RUNTIME_A)?.lastDeliveredSeq,
    itemState: itemStateOf(3)
  }).toEqual({ committed: false, binding: bindingBefore, meshDelivered: 0, itemState: 'queued' });
});

test('a failure in the binding-cursor half rolls back the item state and both cursors atomically', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  own(RUNTIME_A);
  enqueueItemAt(RUNTIME_A, 3);
  const bindingBefore = store.getSessionBinding(session.id, member.id);
  // Force the second-half write (the SessionBinding delivered-cursor UPDATE) to abort, proving the whole
  // transaction — inbox item state, legacy mesh cursor, and binding cursor — commits or rolls back as one.
  const sqlite = (store as unknown as { sqlite: Database }).sqlite;
  sqlite.run(
    `CREATE TRIGGER block_binding_cursor BEFORE UPDATE OF last_delivered_seq ON session_bindings
     BEGIN SELECT RAISE(ABORT, 'blocked binding cursor'); END`
  );
  try {
    expect(() => store.markMeshAgentInboxDelivered(RUNTIME_A, 8)).toThrow('blocked binding cursor');
    expect({
      binding: store.getSessionBinding(session.id, member.id),
      meshDelivered: store.getMeshSession(RUNTIME_A)?.lastDeliveredSeq,
      itemState: itemStateOf(3)
    }).toEqual({ binding: bindingBefore, meshDelivered: 0, itemState: 'queued' });
  } finally {
    sqlite.run('DROP TRIGGER block_binding_cursor');
  }
});

test('a non-managed runtime keeps the legacy item and mesh cursor path with no binding involvement', () => {
  store.upsertMeshSession(runtime(RUNTIME_C, 'interactive'));
  enqueueItemAt(RUNTIME_C, 2);

  store.markMeshAgentInboxDelivered(RUNTIME_C, 6);

  expect({
    meshDelivered: store.getMeshSession(RUNTIME_C)?.lastDeliveredSeq,
    itemState: itemStateOf(2),
    // The owning member's binding is untouched — interactive runtimes never flow through a binding.
    binding: store.getSessionBinding(session.id, member.id)
  }).toEqual({ meshDelivered: 6, itemState: 'delivered', binding: freshBinding });
});

test('managed inbox reads resolve the binding watermark, not the frozen mesh cursor', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  own(RUNTIME_A);
  for (let seq = 1; seq <= 5; seq++) seedItem(RUNTIME_A, seq);
  store.markMeshAgentInboxDelivered(RUNTIME_A, 5);
  store.markMeshAgentInboxVisible(RUNTIME_A, 3);

  // Binding: delivered 5, visible 3; the mesh cursor is frozen at 0/0. If the reads still used the mesh
  // cursor, count/list would report all 5 items — they must report only what is past the binding visible.
  expect({
    hasUnconsumed: store.hasUnconsumedMeshAgentInbox(RUNTIME_A),
    count: store.countMeshAgentInbox(RUNTIME_A),
    listSeqs: store.listMeshAgentInbox(RUNTIME_A).map((item) => item.seq),
    cursor: store.meshAgentInboxCursor(RUNTIME_A),
    meshFrozen: [store.getMeshSession(RUNTIME_A)?.lastDeliveredSeq, store.getMeshSession(RUNTIME_A)?.lastVisibleSeq]
  }).toEqual({
    hasUnconsumed: true,
    count: 2,
    listSeqs: [4, 5],
    cursor: { deliveredSeq: 5, visibleSeq: 3 },
    meshFrozen: [0, 0]
  });
});

test('a superseded managed runtime still reads its owning binding watermark', () => {
  store.upsertMeshSession(runtime(RUNTIME_A));
  own(RUNTIME_A);
  for (let seq = 1; seq <= 5; seq++) seedItem(RUNTIME_A, seq);
  store.markMeshAgentInboxVisible(RUNTIME_A, 3);
  // A fresh runtime B becomes the binding's current attachment; A is now superseded.
  store.upsertMeshSession(runtime(RUNTIME_B));
  own(RUNTIME_B);

  // Reading the superseded runtime A must still resolve the owner's binding watermark (visible 3), not
  // fence to zero — a read is not gated on the runtime still being the binding's current.
  expect({
    count: store.countMeshAgentInbox(RUNTIME_A),
    listSeqs: store.listMeshAgentInbox(RUNTIME_A).map((item) => item.seq),
    cursor: store.meshAgentInboxCursor(RUNTIME_A)
  }).toEqual({ count: 2, listSeqs: [4, 5], cursor: { deliveredSeq: 0, visibleSeq: 3 } });
});

test('managed inbox reads fail closed for an unowned runtime (non-zero mesh cursor proves no fallback)', () => {
  // RUNTIME_B is managed but was never owned. Its mesh cursor is deliberately non-zero, so a silent
  // fallback to the legacy cursor would return a real result — every read must throw the invariant instead.
  store.upsertMeshSession({ ...runtime(RUNTIME_B), lastDeliveredSeq: 9, lastVisibleSeq: 7 });
  seedItem(RUNTIME_B, 1);

  expect(() => store.hasUnconsumedMeshAgentInbox(RUNTIME_B)).toThrow(MeshAgentDeliveryOwnershipError);
  expect(() => store.countMeshAgentInbox(RUNTIME_B)).toThrow(MeshAgentDeliveryOwnershipError);
  expect(() => store.listMeshAgentInbox(RUNTIME_B)).toThrow(MeshAgentDeliveryOwnershipError);
  expect(() => store.meshAgentInboxCursor(RUNTIME_B)).toThrow(MeshAgentDeliveryOwnershipError);
});

test('managed inbox reads fail closed when the owner is set but its binding is gone (non-zero mesh cursor)', () => {
  // Owned (project_member_id set) but the SessionBinding row is missing — the other invariant branch.
  // The mesh cursor is non-zero so a fallback would return a real result; every read must throw instead.
  store.upsertMeshSession({ ...runtime(RUNTIME_A), lastDeliveredSeq: 9, lastVisibleSeq: 7 });
  own(RUNTIME_A);
  seedItem(RUNTIME_A, 1);
  const sqlite = (store as unknown as { sqlite: Database }).sqlite;
  sqlite
    .query('DELETE FROM session_bindings WHERE session_id = ? AND project_member_id = ?')
    .run(session.id, member.id);
  if (store.getMeshSession(RUNTIME_A)?.projectMemberId !== member.id) {
    throw new Error('fixture must keep the runtime owner after deleting the binding');
  }

  expect(() => store.hasUnconsumedMeshAgentInbox(RUNTIME_A)).toThrow(MeshAgentDeliveryOwnershipError);
  expect(() => store.countMeshAgentInbox(RUNTIME_A)).toThrow(MeshAgentDeliveryOwnershipError);
  expect(() => store.listMeshAgentInbox(RUNTIME_A)).toThrow(MeshAgentDeliveryOwnershipError);
  expect(() => store.meshAgentInboxCursor(RUNTIME_A)).toThrow(MeshAgentDeliveryOwnershipError);
});

test('a non-managed runtime read uses the legacy mesh cursor with no binding involvement', () => {
  store.upsertMeshSession(runtime(RUNTIME_C, 'interactive'));
  for (let seq = 1; seq <= 5; seq++) seedItem(RUNTIME_C, seq);
  store.markMeshAgentInboxVisible(RUNTIME_C, 3);

  expect({
    count: store.countMeshAgentInbox(RUNTIME_C),
    listSeqs: store.listMeshAgentInbox(RUNTIME_C).map((item) => item.seq),
    cursor: store.meshAgentInboxCursor(RUNTIME_C),
    meshVisible: store.getMeshSession(RUNTIME_C)?.lastVisibleSeq
  }).toEqual({
    count: 2,
    listSeqs: [4, 5],
    // A non-managed runtime's cursor is the mesh row itself, which the mark* still advances.
    cursor: { deliveredSeq: 0, visibleSeq: 3 },
    meshVisible: 3
  });
});
