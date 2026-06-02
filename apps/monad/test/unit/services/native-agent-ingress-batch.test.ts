import { expect, test } from 'bun:test';

import { claimNativeAgentDeliveryBatch } from '#/services/native-agent/ingress-batch.ts';
import { createStore } from '#/store/db/index.ts';

test('claims all accumulated room and direct ingress as one consumable delivery batch', () => {
  const store = createStore();
  try {
    store.insertMessage('msg_BATCHROOM001', 'ses_BATCHROOM001', 'room body', '2026-07-22T01:00:00.000Z', 'user');
    store.insertNativeAgentDirectMessage({
      id: 'msg_BATCHDIRECT1',
      sessionId: 'ses_BATCHROOM001',
      meshSessionId: 'mesh_BATCHSENDER1',
      fromAgent: 'reviewer',
      peer: 'builder',
      text: 'direct body',
      createdAt: '2026-07-22T01:00:01.000Z'
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_BATCHROOM001',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_BATCHROOM001', 'msg_BATCHROOM001'),
        messageId: 'msg_BATCHROOM001'
      }
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_BATCHROOM001',
      memberInstanceId: 'builder',
      source: { kind: 'direct', directMessageId: 'msg_BATCHDIRECT1' }
    });

    const batch = claimNativeAgentDeliveryBatch(store, 'prj_BATCHROOM001', 'ses_BATCHROOM001', 'builder');

    expect(batch?.items.map((item) => [item.ingressSeq, item.source, item.text])).toEqual([
      [1, 'project', 'room body'],
      [2, 'direct', 'direct body']
    ]);
    expect(batch?.prompt).toContain('"batchId":"deliv_');
    expect(batch?.prompt).toContain('"messageId":"msg_BATCHROOM001"');
    expect(batch?.prompt).toContain('"directMessageId":"msg_BATCHDIRECT1"');
    batch?.accept();
    expect(store.consumeNativeAgentPendingInbox('prj_BATCHROOM001', 'ses_BATCHROOM001', 'builder')).toEqual([]);
  } finally {
    store.close();
  }
});

test('release makes a pre-acceptance batch available to the next claimant', () => {
  const store = createStore();
  try {
    store.insertMessage('msg_BATCHRETRY01', 'ses_BATCHRETRY01', 'retry body', new Date().toISOString(), 'user');
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_BATCHRETRY01',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_BATCHRETRY01', 'msg_BATCHRETRY01'),
        messageId: 'msg_BATCHRETRY01'
      }
    });

    const first = claimNativeAgentDeliveryBatch(store, 'prj_BATCHRETRY01', 'ses_BATCHRETRY01', 'builder');
    first?.release();
    const second = claimNativeAgentDeliveryBatch(store, 'prj_BATCHRETRY01', 'ses_BATCHRETRY01', 'builder');

    expect(second?.items.map((item) => item.text)).toEqual(['retry body']);
    second?.accept();
    expect(claimNativeAgentDeliveryBatch(store, 'prj_BATCHRETRY01', 'ses_BATCHRETRY01', 'builder')).toBeNull();
  } finally {
    store.close();
  }
});

test('automatic prompt and inbox check compete for one claim without duplicate bodies', () => {
  const store = createStore();
  try {
    store.insertMessage('msg_BATCHRACE001', 'ses_BATCHRACE001', 'race body', new Date().toISOString(), 'user');
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_BATCHRACE001',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_BATCHRACE001', 'msg_BATCHRACE001'),
        messageId: 'msg_BATCHRACE001'
      }
    });

    const promptClaim = claimNativeAgentDeliveryBatch(store, 'prj_BATCHRACE001', 'ses_BATCHRACE001', 'builder');
    expect(store.consumeNativeAgentPendingInbox('prj_BATCHRACE001', 'ses_BATCHRACE001', 'builder')).toEqual([]);
    promptClaim?.release();
    expect(
      store
        .consumeNativeAgentPendingInbox('prj_BATCHRACE001', 'ses_BATCHRACE001', 'builder')
        .map((item) => item.message.text)
    ).toEqual(['race body']);
    expect(claimNativeAgentDeliveryBatch(store, 'prj_BATCHRACE001', 'ses_BATCHRACE001', 'builder')).toBeNull();
  } finally {
    store.close();
  }
});

test('arrivals after the claim high-water mark form one later batch', () => {
  const store = createStore();
  try {
    store.insertMessage('msg_BATCHWAVE001', 'ses_BATCHWAVE001', 'first wave', new Date().toISOString(), 'user');
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_BATCHWAVE001',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_BATCHWAVE001', 'msg_BATCHWAVE001'),
        messageId: 'msg_BATCHWAVE001'
      }
    });
    const first = claimNativeAgentDeliveryBatch(store, 'prj_BATCHWAVE001', 'ses_BATCHWAVE001', 'builder');

    store.insertMessage('msg_BATCHWAVE002', 'ses_BATCHWAVE001', 'second wave', new Date().toISOString(), 'user');
    store.insertMessage('msg_BATCHWAVE003', 'ses_BATCHWAVE001', 'third wave', new Date().toISOString(), 'user');
    for (const messageId of ['msg_BATCHWAVE002', 'msg_BATCHWAVE003'] as const) {
      store.enqueueNativeAgentIngressItem({
        projectId: 'prj_BATCHWAVE001',
        memberInstanceId: 'builder',
        source: {
          kind: 'project',
          messageSeq: store.messageSeq('ses_BATCHWAVE001', messageId),
          messageId
        }
      });
    }
    first?.accept();
    const second = claimNativeAgentDeliveryBatch(store, 'prj_BATCHWAVE001', 'ses_BATCHWAVE001', 'builder');

    expect(first?.items.map((item) => item.text)).toEqual(['first wave']);
    expect(second?.items.map((item) => item.text)).toEqual(['second wave', 'third wave']);
    second?.accept();
  } finally {
    store.close();
  }
});
