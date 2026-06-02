import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';
import {
  cancelNativeAgentAsk,
  createNativeAgentAsk,
  finishNativeAgentAskRecovery,
  getNativeAgentAsk,
  getNativeAgentMemberGate,
  reconcileNativeAgentAsksAfterRestart,
  settleNativeAgentAsk,
  transitionNativeAgentMemberGate
} from '#/store/db/native-agent-asks.ts';
import {
  claimNativeAgentIngressBatch,
  enqueueNativeAgentIngressItem,
  listClaimedNativeAgentIngress
} from '#/store/db/native-agent-ingress.ts';

function sqliteOf(store: ReturnType<typeof createStore>): Database {
  return (store as unknown as { sqlite: Database }).sqlite;
}

test('creates one unresolved multi-question ask and gate atomically per member', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const ask = createNativeAgentAsk(sqlite, {
      requestId: 'ask_card00000001',
      projectId: 'prj_card00000001',
      projectSessionId: 'ses_card00000001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_card0000001',
      blocking: true,
      questions: [
        { id: 'q1', question: 'Pick one', options: ['A', 'B'], mode: 'single', allowOther: true },
        { id: 'why', question: 'Why?', options: [], mode: 'single', allowOther: true }
      ],
      createdAt: '2026-07-21T00:00:00.000Z'
    });

    expect(ask).toEqual({
      requestId: 'ask_card00000001',
      projectId: 'prj_card00000001',
      projectSessionId: 'ses_card00000001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_card0000001',
      blocking: true,
      state: 'awaiting_human',
      questions: [
        { id: 'q1', question: 'Pick one', options: ['A', 'B'], mode: 'single', allowOther: true },
        { id: 'why', question: 'Why?', options: [], mode: 'single', allowOther: true }
      ],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z'
    });
    expect(getNativeAgentMemberGate(sqlite, 'ses_card00000001', 'builder')).toEqual({
      projectId: 'prj_card00000001',
      projectSessionId: 'ses_card00000001',
      memberInstanceId: 'builder',
      requestId: 'ask_card00000001',
      state: 'awaiting_human',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z'
    });

    expect(() =>
      createNativeAgentAsk(sqlite, {
        requestId: 'ask_card00000002',
        projectId: 'prj_card00000001',
        projectSessionId: 'ses_card00000001',
        memberInstanceId: 'builder',
        blocking: false,
        questions: [{ id: 'q1', question: 'Another?', options: [], mode: 'single', allowOther: true }]
      })
    ).toThrow('Member builder already has an unresolved project ask');
    expect(getNativeAgentAsk(sqlite, 'ask_card00000001')).toEqual(ask);
  } finally {
    store.close();
  }
});

test('allows the same project member to hold independent asks in different sessions', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_binding000001',
      projectId: 'prj_binding000001',
      projectSessionId: 'ses_binding000001',
      memberInstanceId: 'builder',
      blocking: true,
      questions: [{ id: 'q1', question: 'First session?', options: [], mode: 'single', allowOther: true }]
    });
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_binding000002',
      projectId: 'prj_binding000001',
      projectSessionId: 'ses_binding000002',
      memberInstanceId: 'builder',
      blocking: true,
      questions: [{ id: 'q1', question: 'Second session?', options: [], mode: 'single', allowOther: true }]
    });

    expect(getNativeAgentAsk(sqlite, 'ask_binding000001')).toMatchObject({
      projectSessionId: 'ses_binding000001',
      state: 'awaiting_human'
    });
    expect(getNativeAgentAsk(sqlite, 'ask_binding000002')).toMatchObject({
      projectSessionId: 'ses_binding000002',
      state: 'awaiting_human'
    });
  } finally {
    store.close();
  }
});

test('settles an ask once and advances its gate to releasing', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_settle000001',
      projectId: 'prj_settle000001',
      projectSessionId: 'ses_settle000001',
      memberInstanceId: 'reviewer',
      blocking: false,
      expiresAt: '2026-07-21T00:04:00.000Z',
      questions: [{ id: 'q1', question: 'Approve?', options: ['Yes', 'No'], mode: 'single', allowOther: true }],
      createdAt: '2026-07-21T00:00:00.000Z'
    });

    expect(
      settleNativeAgentAsk(sqlite, {
        requestId: 'ask_settle000001',
        outcome: 'answered',
        answers: { q1: 'Yes' },
        at: '2026-07-21T00:01:00.000Z'
      })
    ).toBe(true);
    expect(
      settleNativeAgentAsk(sqlite, {
        requestId: 'ask_settle000001',
        outcome: 'timed_out',
        at: '2026-07-21T00:02:00.000Z'
      })
    ).toBe(false);
    expect(getNativeAgentAsk(sqlite, 'ask_settle000001')).toMatchObject({
      state: 'releasing',
      outcome: 'answered',
      answers: { q1: 'Yes' },
      resolvedAt: '2026-07-21T00:01:00.000Z'
    });
    expect(getNativeAgentMemberGate(sqlite, 'ses_settle000001', 'reviewer')?.state).toBe('releasing');
    expect(
      transitionNativeAgentMemberGate(sqlite, 'ask_settle000001', 'releasing', 'recovering', '2026-07-21T00:01:01.000Z')
    ).toBe(true);
    expect(finishNativeAgentAskRecovery(sqlite, 'ask_settle000001', '2026-07-21T00:01:02.000Z')).toBe(true);
    expect(getNativeAgentAsk(sqlite, 'ask_settle000001')?.state).toBe('recovered');
    expect(getNativeAgentMemberGate(sqlite, 'ses_settle000001', 'reviewer')).toBeNull();
  } finally {
    store.close();
  }
});

test('finishes recovery when another admitted turn already owns the remaining session ingress', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    store.insertMessage(
      'msg_claimedturn001',
      'ses_claimedturn001',
      'owned by admitted turn',
      '2026-07-21T00:00:01.000Z',
      'user'
    );
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_claimedturn001',
      projectId: 'prj_claimedturn001',
      projectSessionId: 'ses_claimedturn001',
      memberInstanceId: 'builder',
      blocking: true,
      questions: [{ id: 'q1', question: 'Continue?', options: [], mode: 'single', allowOther: true }]
    });
    enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_claimedturn001',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_claimedturn001', 'msg_claimedturn001'),
        messageId: 'msg_claimedturn001'
      }
    });
    settleNativeAgentAsk(sqlite, {
      requestId: 'ask_claimedturn001',
      outcome: 'answered',
      answers: { q1: 'Yes' }
    });
    transitionNativeAgentMemberGate(sqlite, 'ask_claimedturn001', 'releasing', 'recovering');
    claimNativeAgentIngressBatch(sqlite, {
      id: 'deliv_claimedturn1',
      projectId: 'prj_claimedturn001',
      sessionId: 'ses_claimedturn001',
      memberInstanceId: 'builder'
    });

    expect(finishNativeAgentAskRecovery(sqlite, 'ask_claimedturn001')).toBe(true);
    expect(getNativeAgentMemberGate(sqlite, 'ses_claimedturn001', 'builder')).toBeNull();
    expect(getNativeAgentAsk(sqlite, 'ask_claimedturn001')?.state).toBe('recovered');
    expect(listClaimedNativeAgentIngress(sqlite, 'deliv_claimedturn1').map((item) => item.text)).toEqual([
      'owned by admitted turn'
    ]);
  } finally {
    store.close();
  }
});

test('restart detaches only synchronous waiters and preserves required asks', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_sync00000001',
      projectId: 'prj_restart00001',
      projectSessionId: 'ses_restart00001',
      memberInstanceId: 'sync',
      blocking: false,
      expiresAt: '2026-07-21T00:04:00.000Z',
      questions: [{ id: 'q1', question: 'Sync?', options: [], mode: 'single', allowOther: true }]
    });
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_required0001',
      projectId: 'prj_restart00001',
      projectSessionId: 'ses_restart00001',
      memberInstanceId: 'required',
      blocking: true,
      questions: [{ id: 'q1', question: 'Required?', options: [], mode: 'single', allowOther: true }]
    });

    expect(reconcileNativeAgentAsksAfterRestart(sqlite, '2026-07-21T00:02:00.000Z')).toEqual(['ask_sync00000001']);
    expect(getNativeAgentAsk(sqlite, 'ask_sync00000001')?.state).toBe('detached_sync');
    expect(getNativeAgentAsk(sqlite, 'ask_required0001')?.state).toBe('awaiting_human');
  } finally {
    store.close();
  }
});

test('restart releases accepted recovery gates for durable ingress redelivery', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    store.insertMessage(
      'msg_restartrecover1',
      'ses_restartrecover1',
      'queued while recovery was interrupted',
      '2026-07-21T00:00:01.000Z',
      'user'
    );
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_restartrecover1',
      projectId: 'prj_restartrecover1',
      projectSessionId: 'ses_restartrecover1',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_restartrecover1',
      blocking: false,
      questions: [{ id: 'q1', question: 'Continue?', options: [], mode: 'single', allowOther: true }]
    });
    settleNativeAgentAsk(sqlite, {
      requestId: 'ask_restartrecover1',
      outcome: 'answered',
      answers: { q1: 'Yes' }
    });
    transitionNativeAgentMemberGate(sqlite, 'ask_restartrecover1', 'releasing', 'recovering');
    const acceptedRecovery = store.claimNextNativeAgentIngressBatch({
      projectId: 'prj_restartrecover1',
      sessionId: 'ses_restartrecover1',
      memberInstanceId: 'builder',
      askRequestId: 'ask_restartrecover1'
    });
    store.markNativeAgentIngressBatchDelivered(acceptedRecovery.id);
    store.consumeNativeAgentIngressBatch(acceptedRecovery.id);
    enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_restartrecover1',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_restartrecover1', 'msg_restartrecover1'),
        messageId: 'msg_restartrecover1'
      }
    });

    reconcileNativeAgentAsksAfterRestart(sqlite, '2026-07-21T00:02:00.000Z');

    expect(getNativeAgentAsk(sqlite, 'ask_restartrecover1')?.state).toBe('recovered');
    // presence-ok: restart reconciliation removes the stale gate so durable ingress can run.
    expect(getNativeAgentMemberGate(sqlite, 'ses_restartrecover1', 'builder')).toBeNull();
    expect(store.listPendingNativeAgentIngressTargets()).toEqual([
      {
        projectId: 'prj_restartrecover1',
        memberInstanceId: 'builder',
        sessionId: 'ses_restartrecover1',
        source: {
          kind: 'project',
          messageSeq: store.messageSeq('ses_restartrecover1', 'msg_restartrecover1'),
          messageId: 'msg_restartrecover1'
        }
      }
    ]);
  } finally {
    store.close();
  }
});

test('native timeout settles once while transport EOF only detaches the synchronous waiter', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    createNativeAgentAsk(sqlite, {
      requestId: 'ask_cancel000001',
      projectId: 'prj_cancel000001',
      projectSessionId: 'ses_cancel000001',
      memberInstanceId: 'builder',
      blocking: false,
      questions: [{ id: 'q1', question: 'Wait?', options: [], mode: 'single', allowOther: true }]
    });

    expect(
      cancelNativeAgentAsk(sqlite, {
        requestId: 'ask_cancel000001',
        projectId: 'prj_cancel000001',
        memberInstanceId: 'builder',
        cause: 'transport_eof'
      })
    ).toBe('detached_sync');
    expect(
      cancelNativeAgentAsk(sqlite, {
        requestId: 'ask_cancel000001',
        projectId: 'prj_cancel000001',
        memberInstanceId: 'builder',
        cause: 'timeout'
      })
    ).toBe('timed_out');
    expect(
      cancelNativeAgentAsk(sqlite, {
        requestId: 'ask_cancel000001',
        projectId: 'prj_cancel000001',
        memberInstanceId: 'builder',
        cause: 'cancelled'
      })
    ).toBe('timed_out');
  } finally {
    store.close();
  }
});
