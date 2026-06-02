import type { Database } from 'bun:sqlite';
import type { MeshSessionId, ProjectMember, Session, WorkplaceProject } from '@monad/protocol';
import type { MeshSessionUpsert } from '#/store/db/mesh-sessions.ts';

import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '#/store/db/index.ts';

const now = '2026-07-28T00:00:00.000Z';
const MESH_ID = 'mesh_restart00001' as MeshSessionId;
const MESH_CUR = 'mesh_restartcur01' as MeshSessionId;
const HIST_A = 'mesh_restarthsta1' as MeshSessionId;
const HIST_B = 'mesh_restarthstb1' as MeshSessionId;
const project: WorkplaceProject = {
  id: 'prj_restart00000',
  title: 'Restart',
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
  id: 'ses_restart00001',
  projectId: project.id,
  title: 'Restart',
  state: 'active',
  agentIds: [],
  archived: false,
  restoreCount: 0,
  activityAt: now,
  createdAt: now,
  updatedAt: now
};

function runtime(id: MeshSessionId): MeshSessionUpsert {
  return {
    id,
    transcriptTargetId: session.id,
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/workspace',
    runtimeRole: 'managed-project-agent',
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

function ownRuntime(store: ReturnType<typeof createStore>, id: MeshSessionId): void {
  store.replaceSessionBindingRuntime({
    sessionId: session.id,
    projectMemberId: member.id,
    currentNativeRuntimeSessionId: id,
    updatedAt: now
  });
}

// Raw per-table item states so we can prove BOTH the mesh inbox and the native ingress ledger persist the
// consumed lifecycle across a real restart — not just the store's projected read.
function itemStates(store: ReturnType<typeof createStore>, table: string, meshId: string): string[] {
  const sqlite = (store as unknown as { sqlite: Database }).sqlite;
  return (
    sqlite.query(`SELECT state FROM ${table} WHERE mesh_session_id = ? ORDER BY message_seq ASC`).all(meshId) as Array<{
      state: string;
    }>
  ).map((row) => row.state);
}

test('durable inbox state survives a file-backed restart: both item tables and the binding watermark, no re-delivery', () => {
  const dbPath = join(tmpdir(), `monad-inbox-restart-${process.hrtime.bigint()}.sqlite`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  };
  try {
    // ── First boot: own a managed runtime, deliver 5 messages, make 3 visible, consume those 3 ──
    const first = createStore({ path: dbPath });
    first.insertWorkplaceProject(project);
    first.insertProjectMember(member);
    first.insertSession(session);
    first.insertSessionBinding({
      sessionId: session.id,
      projectMemberId: member.id,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now
    });
    for (let seq = 1; seq <= 5; seq++) {
      first.insertMessage(`msg_restartmsg0${seq}`, session.id, `msg ${seq}`, `2026-07-28T00:00:0${seq}.000Z`, 'user');
    }
    first.upsertMeshSession(runtime(MESH_ID));
    first.replaceSessionBindingRuntime({
      sessionId: session.id,
      projectMemberId: member.id,
      currentNativeRuntimeSessionId: MESH_ID,
      updatedAt: now
    });
    for (let seq = 1; seq <= 5; seq++) {
      // Full options so enqueue populates BOTH mesh_agent_inbox_items and native_agent_ingress_items.
      first.enqueueMeshAgentInboxItem(MESH_ID, seq, {
        deliveryId: `deliv_restartdlv0${seq}`,
        projectId: project.id,
        memberInstanceId: member.id,
        triggerMessageId: `msg_restartmsg0${seq}`
      });
    }
    first.markMeshAgentInboxDelivered(MESH_ID, 5);
    first.markMeshAgentInboxVisible(MESH_ID, 3);
    first.markMeshAgentInboxConsumed(MESH_ID, 3);

    const preBinding = first.getSessionBinding(session.id, member.id);
    expect({
      binding: {
        delivered: preBinding?.lastDeliveredSeq,
        visible: preBinding?.lastVisibleSeq,
        current: preBinding?.currentNativeRuntimeSessionId
      },
      meshItems: itemStates(first, 'mesh_agent_inbox_items', MESH_ID),
      ingressItems: itemStates(first, 'native_agent_ingress_items', MESH_ID),
      count: first.countMeshAgentInbox(MESH_ID),
      meshFrozen: [first.getMeshSession(MESH_ID)?.lastDeliveredSeq, first.getMeshSession(MESH_ID)?.lastVisibleSeq]
    }).toEqual({
      binding: { delivered: 5, visible: 3, current: MESH_ID },
      meshItems: ['consumed', 'consumed', 'consumed', 'delivered', 'delivered'],
      ingressItems: ['consumed', 'consumed', 'consumed', 'delivered', 'delivered'],
      // Only messages 4 and 5 are past the visible watermark — the 3 consumed ones are not counted.
      count: 2,
      // The managed mesh cursor was frozen throughout; the binding is the sole watermark.
      meshFrozen: [0, 0]
    });
    first.close();

    // ── Restart: reopen the durable file and run the boot reconcile order ──
    const rebooted = createStore({ path: dbPath });
    try {
      rebooted.reconcileOrphanedMeshSessions(() => {});
      rebooted.reconcileSessionBindingRuntimesAfterRestart();

      const binding = rebooted.getSessionBinding(session.id, member.id);
      expect({
        binding: {
          delivered: binding?.lastDeliveredSeq,
          visible: binding?.lastVisibleSeq,
          current: binding?.currentNativeRuntimeSessionId,
          health: binding?.lastHealth
        },
        // Both durable ledgers keep the consumed lifecycle across the restart.
        meshItems: itemStates(rebooted, 'mesh_agent_inbox_items', MESH_ID),
        ingressItems: itemStates(rebooted, 'native_agent_ingress_items', MESH_ID),
        // Reads still resolve the surviving binding watermark, so the consumed 3 are never re-surfaced.
        hasUnconsumed: rebooted.hasUnconsumedMeshAgentInbox(MESH_ID),
        count: rebooted.countMeshAgentInbox(MESH_ID),
        listSeqs: rebooted.listMeshAgentInbox(MESH_ID).map((item) => item.seq)
      }).toEqual({
        binding: { delivered: 5, visible: 3, current: null, health: 'stopped' },
        meshItems: ['consumed', 'consumed', 'consumed', 'delivered', 'delivered'],
        ingressItems: ['consumed', 'consumed', 'consumed', 'delivered', 'delivered'],
        hasUnconsumed: true,
        count: 2,
        listSeqs: [4, 5]
      });
    } finally {
      rebooted.close();
    }
  } finally {
    cleanup();
  }
});

test('restart aggregates every durable-owned runtime into the binding, freezes the mesh row, and is idempotent', () => {
  const dbPath = join(tmpdir(), `monad-inbox-restart-multi-${process.hrtime.bigint()}.sqlite`);
  const cleanup = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  };
  try {
    // ── First boot: three runtimes for one owner. Two historical ones carry different (pre-freeze) MAX
    // watermarks; the current one runs the consume flow with a frozen mesh cursor. ──
    const first = createStore({ path: dbPath });
    first.insertWorkplaceProject(project);
    first.insertProjectMember(member);
    first.insertSession(session);
    first.insertSessionBinding({
      sessionId: session.id,
      projectMemberId: member.id,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now
    });
    for (let seq = 1; seq <= 5; seq++) {
      first.insertMessage(`msg_restartmsg0${seq}`, session.id, `msg ${seq}`, `2026-07-28T00:00:0${seq}.000Z`, 'user');
    }
    // HIST_A contributes the delivered MAX (8), HIST_B the visible MAX (6); both above the binding.
    first.upsertMeshSession({ ...runtime(HIST_A), lastDeliveredSeq: 8, lastVisibleSeq: 2 });
    ownRuntime(first, HIST_A);
    first.upsertMeshSession({ ...runtime(HIST_B), lastDeliveredSeq: 7, lastVisibleSeq: 6 });
    ownRuntime(first, HIST_B);
    first.upsertMeshSession(runtime(MESH_CUR));
    ownRuntime(first, MESH_CUR);
    for (let seq = 1; seq <= 5; seq++) {
      first.enqueueMeshAgentInboxItem(MESH_CUR, seq, {
        deliveryId: `deliv_restartdlv0${seq}`,
        projectId: project.id,
        memberInstanceId: member.id,
        triggerMessageId: `msg_restartmsg0${seq}`
      });
    }

    // The managed mark* must never touch the current runtime's mesh row — snapshot it and compare exactly.
    const meshRowBeforeMarks = first.getMeshSession(MESH_CUR);
    first.markMeshAgentInboxDelivered(MESH_CUR, 5);
    first.markMeshAgentInboxVisible(MESH_CUR, 3);
    first.markMeshAgentInboxConsumed(MESH_CUR, 3);
    expect(first.getMeshSession(MESH_CUR)).toEqual(meshRowBeforeMarks);
    first.close();

    // ── First restart: the binding takes the delivered MAX from HIST_A and the visible MAX from HIST_B ──
    type StoreT = ReturnType<typeof createStore>;
    let recoveredBinding: ReturnType<StoreT['getSessionBinding']>;
    let recoveredRuntimes: Array<ReturnType<StoreT['getMeshSession']>>;
    let recoveredMeshItems: string[];
    let recoveredIngressItems: string[];
    const rebooted = createStore({ path: dbPath });
    try {
      rebooted.reconcileOrphanedMeshSessions(() => {});
      rebooted.reconcileSessionBindingRuntimesAfterRestart();
      recoveredBinding = rebooted.getSessionBinding(session.id, member.id);
      recoveredRuntimes = [HIST_A, HIST_B, MESH_CUR].map((id) => rebooted.getMeshSession(id));
      recoveredMeshItems = itemStates(rebooted, 'mesh_agent_inbox_items', MESH_CUR);
      recoveredIngressItems = itemStates(rebooted, 'native_agent_ingress_items', MESH_CUR);
      expect({
        // delivered MAX comes from HIST_A (8), visible MAX from HIST_B (6) — aggregated across all
        // durable-owned runtimes, independently per cursor. current is cleared; health is the terminal
        // state written by the original current runtime (order-independent); both ledgers persist.
        delivered: recoveredBinding?.lastDeliveredSeq,
        visible: recoveredBinding?.lastVisibleSeq,
        current: recoveredBinding?.currentNativeRuntimeSessionId,
        health: recoveredBinding?.lastHealth,
        meshItems: recoveredMeshItems,
        ingressItems: recoveredIngressItems
      }).toEqual({
        delivered: 8,
        visible: 6,
        current: null,
        health: 'stopped',
        meshItems: ['consumed', 'consumed', 'consumed', 'delivered', 'delivered'],
        ingressItems: ['consumed', 'consumed', 'consumed', 'delivered', 'delivered']
      });
    } finally {
      rebooted.close();
    }

    // ── Second restart: already converged, so recovery is a no-op and every durable record is byte-equal ──
    const again = createStore({ path: dbPath });
    try {
      again.reconcileOrphanedMeshSessions(() => {});
      const stats = again.reconcileSessionBindingRuntimesAfterRestart();
      expect({
        stats,
        binding: again.getSessionBinding(session.id, member.id),
        runtimes: [HIST_A, HIST_B, MESH_CUR].map((id) => again.getMeshSession(id)),
        meshItems: itemStates(again, 'mesh_agent_inbox_items', MESH_CUR),
        ingressItems: itemStates(again, 'native_agent_ingress_items', MESH_CUR)
      }).toEqual({
        stats: { recovered: 0, skipped: 0, conflicts: 0 },
        binding: recoveredBinding,
        runtimes: recoveredRuntimes,
        meshItems: recoveredMeshItems,
        ingressItems: recoveredIngressItems
      });
    } finally {
      again.close();
    }
  } finally {
    cleanup();
  }
});

// The original current runtime must write the binding's terminal health no matter where it lands in the
// restart reconcile's row order (listMeshSessions is started_at DESC). Before the snapshot fix, a
// historical runtime processed first cleared the current pointer and the true current was misjudged
// non-authoritative, freezing a stale 'running' health.
for (const variant of [
  { label: 'current runtime processed last', cur: '2026-07-28T00:00:01.000Z', hist: '2026-07-28T00:00:09.000Z' },
  { label: 'current runtime processed first', cur: '2026-07-28T00:00:09.000Z', hist: '2026-07-28T00:00:01.000Z' }
] as const) {
  test(`restart records the original current runtime terminal health regardless of row order (${variant.label})`, () => {
    const store = createStore();
    try {
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
      store.upsertMeshSession({ ...runtime(HIST_A), lastDeliveredSeq: 8, lastVisibleSeq: 2, startedAt: variant.hist });
      ownRuntime(store, HIST_A);
      store.upsertMeshSession({ ...runtime(HIST_B), lastDeliveredSeq: 7, lastVisibleSeq: 6, startedAt: variant.hist });
      ownRuntime(store, HIST_B);
      store.upsertMeshSession({ ...runtime(MESH_CUR), startedAt: variant.cur });
      ownRuntime(store, MESH_CUR);

      store.reconcileOrphanedMeshSessions(() => {});
      store.reconcileSessionBindingRuntimesAfterRestart();

      const binding = store.getSessionBinding(session.id, member.id);
      expect({
        health: binding?.lastHealth,
        current: binding?.currentNativeRuntimeSessionId,
        delivered: binding?.lastDeliveredSeq,
        visible: binding?.lastVisibleSeq
      }).toEqual({ health: 'stopped', current: null, delivered: 8, visible: 6 });
    } finally {
      store.close();
    }
  });
}

// A live start sets binding.current=NEW inside the launcher BEFORE the legacy session_members.mesh_session_id
// moves off OLD; a daemon exit in that window leaves current=NEW but the legacy link still on a terminal
// OLD. The binding's current (NEW) is the sole health authority — the stale legacy link must not make OLD a
// second authority and backwash its 'failed' state. Proven order-independent AND idempotent on re-boot.
for (const variant of [
  {
    label: 'NEW current processed last',
    newStarted: '2026-07-28T00:00:01.000Z',
    oldStarted: '2026-07-28T00:00:09.000Z'
  },
  {
    label: 'NEW current processed first',
    newStarted: '2026-07-28T00:00:09.000Z',
    oldStarted: '2026-07-28T00:00:01.000Z'
  }
] as const) {
  test(`restart takes health from the current runtime, not a stale legacy-linked terminal runtime (${variant.label})`, () => {
    const OLD_RT = 'mesh_restartold01' as MeshSessionId;
    const store = createStore();
    try {
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
      // OLD: owned, carries the cursor MAX, then goes terminal 'failed'. The legacy SessionMember still
      // points at it.
      store.upsertMeshSession({
        ...runtime(OLD_RT),
        lastDeliveredSeq: 8,
        lastVisibleSeq: 6,
        startedAt: variant.oldStarted
      });
      ownRuntime(store, OLD_RT);
      store.closeMeshSession(OLD_RT, '2026-07-28T00:01:00.000Z', null, 'failed');
      store.insertSessionMember({
        sessionId: session.id,
        memberId: member.id,
        templateId: null,
        type: 'mesh-agent',
        data: { name: 'codex' },
        createdAt: now,
        updatedAt: now
      });
      store.updateSessionMember(session.id, member.id, { meshSessionId: OLD_RT, updatedAt: now });
      // NEW: the binding's current at the crash, still 'running'.
      store.upsertMeshSession({
        ...runtime(MESH_CUR),
        lastDeliveredSeq: 2,
        lastVisibleSeq: 1,
        startedAt: variant.newStarted
      });
      ownRuntime(store, MESH_CUR);

      store.reconcileOrphanedMeshSessions(() => {});
      store.reconcileSessionBindingRuntimesAfterRestart();

      const afterFirst = store.getSessionBinding(session.id, member.id);
      expect({
        delivered: afterFirst?.lastDeliveredSeq,
        visible: afterFirst?.lastVisibleSeq,
        current: afterFirst?.currentNativeRuntimeSessionId,
        // Health is NEW's terminal state ('stopped'), never OLD's 'failed'.
        health: afterFirst?.lastHealth
      }).toEqual({ delivered: 8, visible: 6, current: null, health: 'stopped' });

      // Second boot: converged, so recovery is a no-op and the binding/runtimes are unchanged — the stale
      // legacy link must not re-heal the health to OLD's terminal state.
      const runtimesAfterFirst = [OLD_RT, MESH_CUR].map((id) => store.getMeshSession(id));
      store.reconcileOrphanedMeshSessions(() => {});
      const stats = store.reconcileSessionBindingRuntimesAfterRestart();
      expect({
        stats,
        binding: store.getSessionBinding(session.id, member.id),
        runtimes: [OLD_RT, MESH_CUR].map((id) => store.getMeshSession(id))
      }).toEqual({
        stats: { recovered: 0, skipped: 0, conflicts: 0 },
        binding: afterFirst,
        runtimes: runtimesAfterFirst
      });
    } finally {
      store.close();
    }
  });
}
