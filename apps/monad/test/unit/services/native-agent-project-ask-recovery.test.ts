import { expect, test } from 'bun:test';

import { NativeAgentMemberDeliveryCoordinator } from '#/services/native-agent/member-delivery-coordinator.ts';
import { createNativeAgentProjectAskRecovery } from '#/services/native-agent/project-ask-recovery.ts';
import { createStore } from '#/store/db/index.ts';

function promptBatch(prompt: string): Record<string, unknown> {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('{'));
  if (!line) throw new Error('recovery prompt did not contain a JSON batch');
  return JSON.parse(line) as Record<string, unknown>;
}

test('recovers a required ask outcome and all claimed room and direct ingress in one prompt', async () => {
  const store = createStore();
  try {
    store.insertMessage('msg_recovery0001', 'ses_recovery0001', 'room update', '2026-07-21T00:00:01.000Z', 'user');
    store.insertNativeAgentDirectMessage({
      id: 'msg_recoverydm01',
      sessionId: 'ses_recovery0001',
      meshSessionId: 'mesh_sender00001',
      fromAgent: 'codex',
      peer: 'builder',
      text: 'private update',
      createdAt: '2026-07-21T00:00:02.000Z'
    });
    store.createNativeAgentAsk({
      requestId: 'ask_recovery0001',
      projectId: 'prj_recovery0001',
      projectSessionId: 'ses_recovery0001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_builder00001',
      blocking: true,
      questions: [{ id: 'q1', question: 'Ship?', options: ['Yes', 'No'], mode: 'single', allowOther: true }]
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_recovery0001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_builder00001',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_recovery0001', 'msg_recovery0001'),
        messageId: 'msg_recovery0001'
      }
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_recovery0001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_builder00001',
      source: { kind: 'direct', directMessageId: 'msg_recoverydm01' }
    });
    store.settleNativeAgentAsk({
      requestId: 'ask_recovery0001',
      outcome: 'answered',
      answers: { q1: 'Yes' }
    });
    const inputs: Array<{ meshSessionId: string; prompt: string }> = [];
    const receipts: string[] = [];
    const recovery = createNativeAgentProjectAskRecovery({
      store,
      coordinator: new NativeAgentMemberDeliveryCoordinator(),
      input: async (meshSessionId, prompt, onAccepted) => {
        onAccepted();
        inputs.push({ meshSessionId, prompt });
      },
      writeDirectReceipt: async (directMessageId) => {
        receipts.push(directMessageId);
      }
    });

    await recovery.schedule('ask_recovery0001', { includeOutcome: true });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.meshSessionId).toBe('mesh_builder00001');
    expect(promptBatch(inputs[0]?.prompt ?? '')).toEqual({
      batchId: 'recovery:ask_recovery0001:1',
      ask: {
        requestId: 'ask_recovery0001',
        outcome: 'answered',
        resolvedAt: expect.any(String)
      },
      questions: [{ id: 'q1', question: 'Ship?', answer: 'Yes' }],
      messages: [
        {
          ingressSeq: 1,
          source: 'project',
          deliveryId: expect.stringMatching(/^deliv_/),
          text: 'room update',
          createdAt: '2026-07-21T00:00:01.000Z',
          messageSeq: 1,
          messageId: 'msg_recovery0001',
          sender: { kind: 'human', name: 'Human' }
        },
        {
          ingressSeq: 2,
          source: 'direct',
          deliveryId: expect.stringMatching(/^deliv_/),
          text: 'private update',
          createdAt: '2026-07-21T00:00:02.000Z',
          directMessageId: 'msg_recoverydm01',
          fromAgent: 'codex',
          peer: 'builder'
        }
      ]
    });
    expect(receipts).toEqual(['msg_recoverydm01']);
    expect(store.getNativeAgentAsk('ask_recovery0001')?.state).toBe('recovered');
    expect(store.getNativeAgentMemberGate('ses_recovery0001', 'builder')).toBeNull();
  } finally {
    store.close();
  }
});

test('live synchronous recovery does not repeat the answer already returned by the tool', async () => {
  const store = createStore();
  try {
    store.insertMessage('msg_syncrecover01', 'ses_syncrecover01', 'queued room item', new Date().toISOString(), 'user');
    store.createNativeAgentAsk({
      requestId: 'ask_syncrecover01',
      projectId: 'prj_syncrecover01',
      projectSessionId: 'ses_syncrecover01',
      memberInstanceId: 'reviewer',
      meshSessionId: 'mesh_reviewer0001',
      blocking: false,
      questions: [{ id: 'q1', question: 'Approve?', options: [], mode: 'single', allowOther: true }]
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_syncrecover01',
      memberInstanceId: 'reviewer',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_syncrecover01', 'msg_syncrecover01'),
        messageId: 'msg_syncrecover01'
      }
    });
    store.settleNativeAgentAsk({
      requestId: 'ask_syncrecover01',
      outcome: 'answered',
      answers: { q1: 'Approved' }
    });
    const prompts: string[] = [];
    const recovery = createNativeAgentProjectAskRecovery({
      store,
      coordinator: new NativeAgentMemberDeliveryCoordinator(),
      input: async (_meshSessionId, prompt, onAccepted) => {
        onAccepted();
        prompts.push(prompt);
      },
      writeDirectReceipt: async () => {}
    });

    await recovery.schedule('ask_syncrecover01', { includeOutcome: false });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('queued room item');
    expect(prompts[0]).not.toContain('Approved');
  } finally {
    store.close();
  }
});

test('recovery leaves another session binding ingress queued for its own runtime', async () => {
  const store = createStore();
  try {
    store.insertMessage(
      'msg_SCOPEDRECOV1',
      'ses_SCOPEDRECOV1',
      'first session update',
      '2026-07-21T00:00:01.000Z',
      'user'
    );
    store.insertMessage(
      'msg_SCOPEDRECOV2',
      'ses_SCOPEDRECOV2',
      'second session update',
      '2026-07-21T00:00:02.000Z',
      'user'
    );
    store.createNativeAgentAsk({
      requestId: 'ask_SCOPEDRECOV1',
      projectId: 'prj_SCOPEDRECOV1',
      projectSessionId: 'ses_SCOPEDRECOV1',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_SCOPEDRECOV1',
      blocking: false,
      questions: [{ id: 'q1', question: 'Continue?', options: [], mode: 'single', allowOther: true }]
    });
    for (const [sessionId, messageId] of [
      ['ses_SCOPEDRECOV1', 'msg_SCOPEDRECOV1'],
      ['ses_SCOPEDRECOV2', 'msg_SCOPEDRECOV2']
    ] as const) {
      store.enqueueNativeAgentIngressItem({
        projectId: 'prj_SCOPEDRECOV1',
        memberInstanceId: 'builder',
        source: {
          kind: 'project',
          messageSeq: store.messageSeq(sessionId, messageId),
          messageId
        }
      });
    }
    store.settleNativeAgentAsk({
      requestId: 'ask_SCOPEDRECOV1',
      outcome: 'answered',
      answers: { q1: 'Yes' }
    });
    const prompts: string[] = [];
    const recovery = createNativeAgentProjectAskRecovery({
      store,
      coordinator: new NativeAgentMemberDeliveryCoordinator(),
      input: async (_meshSessionId, prompt, onAccepted) => {
        onAccepted();
        prompts.push(prompt);
      },
      writeDirectReceipt: async () => {}
    });

    await recovery.schedule('ask_SCOPEDRECOV1', { includeOutcome: false });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('first session update');
    expect(prompts[0]).not.toContain('second session update');
    expect(store.listPendingNativeAgentIngressTargets()).toEqual([
      {
        projectId: 'prj_SCOPEDRECOV1',
        memberInstanceId: 'builder',
        sessionId: 'ses_SCOPEDRECOV2',
        source: {
          kind: 'project',
          messageSeq: store.messageSeq('ses_SCOPEDRECOV2', 'msg_SCOPEDRECOV2'),
          messageId: 'msg_SCOPEDRECOV2'
        }
      }
    ]);
  } finally {
    store.close();
  }
});

test('keeps the gate closed and compresses arrivals during recovery into the next batch', async () => {
  const store = createStore();
  try {
    store.insertMessage(
      'msg_recoverywave1',
      'ses_recoverywave1',
      'first queued update',
      '2026-07-21T00:00:01.000Z',
      'user'
    );
    store.createNativeAgentAsk({
      requestId: 'ask_recoverywave1',
      projectId: 'prj_recoverywave1',
      projectSessionId: 'ses_recoverywave1',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_recoverywave1',
      blocking: true,
      questions: [{ id: 'q1', question: 'Continue?', options: [], mode: 'single', allowOther: true }]
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_recoverywave1',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_recoverywave1', 'msg_recoverywave1'),
        messageId: 'msg_recoverywave1'
      }
    });
    store.settleNativeAgentAsk({
      requestId: 'ask_recoverywave1',
      outcome: 'answered',
      answers: { q1: 'Yes' }
    });
    const prompts: string[] = [];
    const recovery = createNativeAgentProjectAskRecovery({
      store,
      coordinator: new NativeAgentMemberDeliveryCoordinator(),
      input: async (_meshSessionId, prompt, onAccepted) => {
        onAccepted();
        prompts.push(prompt);
        if (prompts.length !== 1) return;
        store.insertMessage(
          'msg_recoverywave2',
          'ses_recoverywave1',
          'second queued update',
          '2026-07-21T00:00:02.000Z',
          'user'
        );
        store.enqueueNativeAgentIngressItem({
          projectId: 'prj_recoverywave1',
          memberInstanceId: 'builder',
          source: {
            kind: 'project',
            messageSeq: store.messageSeq('ses_recoverywave1', 'msg_recoverywave2'),
            messageId: 'msg_recoverywave2'
          }
        });
      },
      writeDirectReceipt: async () => {}
    });

    await recovery.schedule('ask_recoverywave1', { includeOutcome: true });

    expect(prompts).toHaveLength(2);
    expect(promptBatch(prompts[0] ?? '')).toEqual(
      expect.objectContaining({
        batchId: 'recovery:ask_recoverywave1:1',
        questions: [{ id: 'q1', question: 'Continue?', answer: 'Yes' }],
        messages: [expect.objectContaining({ text: 'first queued update' })]
      })
    );
    expect(promptBatch(prompts[1] ?? '')).toEqual({
      batchId: 'recovery:ask_recoverywave1:2',
      messages: [expect.objectContaining({ text: 'second queued update' })]
    });
    expect(store.getNativeAgentMemberGate('ses_recoverywave1', 'builder')).toBeNull();
    expect(store.getNativeAgentAsk('ask_recoverywave1')?.state).toBe('recovered');
  } finally {
    store.close();
  }
});

test('does not replay a batch when the provider fails after local input acceptance', async () => {
  const store = createStore();
  try {
    store.insertMessage('msg_ACCEPTERR001', 'ses_ACCEPTERR001', 'accepted once', new Date().toISOString(), 'user');
    store.createNativeAgentAsk({
      requestId: 'ask_ACCEPTERR001',
      projectId: 'prj_ACCEPTERR001',
      projectSessionId: 'ses_ACCEPTERR001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_ACCEPTEDERR1',
      blocking: true,
      questions: [{ id: 'q1', question: 'Continue?', options: [], mode: 'single', allowOther: true }]
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_ACCEPTERR001',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_ACCEPTERR001', 'msg_ACCEPTERR001'),
        messageId: 'msg_ACCEPTERR001'
      }
    });
    store.settleNativeAgentAsk({ requestId: 'ask_ACCEPTERR001', outcome: 'answered', answers: { q1: 'Yes' } });
    let inputs = 0;
    const recovery = createNativeAgentProjectAskRecovery({
      store,
      coordinator: new NativeAgentMemberDeliveryCoordinator(),
      input: async (_meshSessionId, _prompt, onAccepted) => {
        inputs += 1;
        onAccepted();
        throw new Error('provider failed after acceptance');
      },
      writeDirectReceipt: async () => {}
    });

    await expect(recovery.schedule('ask_ACCEPTERR001', { includeOutcome: true })).rejects.toThrow(
      'provider failed after acceptance'
    );
    await recovery.schedule('ask_ACCEPTERR001', { includeOutcome: false });

    expect(inputs).toBe(1);
    expect(store.getNativeAgentAsk('ask_ACCEPTERR001')?.state).toBe('recovered');
    expect(store.consumeNativeAgentPendingInbox('prj_ACCEPTERR001', 'ses_ACCEPTERR001', 'builder')).toEqual([]);
  } finally {
    store.close();
  }
});
