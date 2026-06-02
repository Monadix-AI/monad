import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';
import {
  acknowledgeVisibleNativeAgentIngress,
  claimNativeAgentIngressBatch,
  consumeNativeAgentIngressBatch,
  consumeNativeAgentPendingInbox,
  enqueueNativeAgentIngressItem,
  listClaimedNativeAgentIngress,
  markNativeAgentIngressVisible,
  reconcileNativeAgentIngressAfterRestart
} from '#/store/db/native-agent-ingress.ts';

function sqliteOf(store: ReturnType<typeof createStore>): Database {
  return (store as unknown as { sqlite: Database }).sqlite;
}

test('allocates one ingress sequence across room and direct sources for a member', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const room = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_ingress00001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_ingress0001',
      source: { kind: 'project', messageSeq: 10, messageId: 'msg_ingress00001' },
      createdAt: '2026-07-21T00:00:00.000Z'
    });
    const direct = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_ingress00001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_ingress0001',
      source: { kind: 'direct', directMessageId: 'dm_ingress000001' },
      createdAt: '2026-07-21T00:00:01.000Z'
    });
    const duplicate = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_ingress00001',
      memberInstanceId: 'builder',
      meshSessionId: 'mesh_ingress0001',
      source: { kind: 'direct', directMessageId: 'dm_ingress000001' },
      createdAt: '2026-07-21T00:00:02.000Z'
    });

    expect([room.ingressSeq, direct.ingressSeq, duplicate.ingressSeq]).toEqual([1, 2, 2]);
    expect(duplicate.id).toBe(direct.id);
    expect(
      sqlite
        .prepare(
          'SELECT source_kind, ingress_seq, message_id, direct_message_id FROM native_agent_ingress_items ORDER BY ingress_seq'
        )
        .all()
    ).toEqual([
      { source_kind: 'project', ingress_seq: 1, message_id: 'msg_ingress00001', direct_message_id: null },
      { source_kind: 'direct', ingress_seq: 2, message_id: null, direct_message_id: 'dm_ingress000001' }
    ]);
  } finally {
    store.close();
  }
});

test('claims recovery items without letting cursor ack consume claimed rows', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    sqlite.exec(`
      INSERT INTO messages (rowid, id, transcript_target_id, role, text, created_at)
      VALUES
        (10, 'msg_claim0000001', 'ses_claim0000001', 'user', 'first', '2026-07-21T00:00:00.000Z'),
        (20, 'msg_claim0000002', 'ses_claim0000001', 'user', 'second', '2026-07-21T00:00:01.000Z');
      INSERT INTO native_agent_direct_messages
        (id, session_id, mesh_session_id, from_agent, peer, text, created_at)
      VALUES
        ('dm_claim00000001', 'ses_claim0000001', 'mesh_claim000001', 'builder', 'reviewer', 'direct',
         '2026-07-21T00:00:02.000Z');
    `);
    const first = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_claim0000001',
      memberInstanceId: 'reviewer',
      source: { kind: 'project', messageSeq: 10, messageId: 'msg_claim0000001' }
    });
    const second = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_claim0000001',
      memberInstanceId: 'reviewer',
      source: { kind: 'project', messageSeq: 20, messageId: 'msg_claim0000002' }
    });
    const direct = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_claim0000001',
      memberInstanceId: 'reviewer',
      source: { kind: 'direct', directMessageId: 'dm_claim00000001' }
    });
    markNativeAgentIngressVisible(sqlite, [first.id]);

    const batch = claimNativeAgentIngressBatch(sqlite, {
      id: 'recovery_claim0001',
      projectId: 'prj_claim0000001',
      sessionId: 'ses_claim0000001',
      memberInstanceId: 'reviewer',
      askRequestId: 'ask_claim0000001'
    });
    const ack = acknowledgeVisibleNativeAgentIngress(sqlite, {
      projectId: 'prj_claim0000001',
      sessionId: 'ses_claim0000001',
      memberInstanceId: 'reviewer',
      requestedCursor: 30
    });

    expect(batch).toEqual({
      id: 'recovery_claim0001',
      highWaterSeq: 3,
      itemIds: [second.id, direct.id]
    });
    expect(ack).toEqual({
      requestedCursor: 30,
      visibleCursor: 10,
      consumedDeliveryIds: [first.deliveryId],
      deferredDeliveryIds: [second.deliveryId]
    });

    consumeNativeAgentIngressBatch(sqlite, batch.id, '2026-07-21T00:00:03.000Z');
    expect(sqlite.prepare('SELECT id, state FROM native_agent_ingress_items ORDER BY ingress_seq').all()).toEqual([
      { id: first.id, state: 'consumed' },
      { id: second.id, state: 'consumed' },
      { id: direct.id, state: 'consumed' }
    ]);
  } finally {
    store.close();
  }
});

test('reads one claimed recovery batch in unified room and direct ingress order', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    sqlite.exec(`
      INSERT INTO messages (id, transcript_target_id, role, text, created_at)
      VALUES ('msg_batch0000001', 'ses_batch0000001', 'user', 'room update', '2026-07-21T00:00:01.000Z');
      INSERT INTO native_agent_direct_messages
        (id, session_id, mesh_session_id, from_agent, peer, text, created_at)
      VALUES
        ('msg_batchdm00001', 'ses_batch0000001', 'mesh_sender00001', 'codex', 'claude', 'private update', '2026-07-21T00:00:02.000Z');
    `);
    const messageSeq = (
      sqlite.prepare("SELECT rowid FROM messages WHERE id = 'msg_batch0000001'").get() as {
        rowid: number;
      }
    ).rowid;
    const room = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_batch0000001',
      memberInstanceId: 'claude',
      source: { kind: 'project', messageSeq, messageId: 'msg_batch0000001' }
    });
    const direct = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_batch0000001',
      memberInstanceId: 'claude',
      source: { kind: 'direct', directMessageId: 'msg_batchdm00001' }
    });
    claimNativeAgentIngressBatch(sqlite, {
      id: 'recovery_batch001',
      projectId: 'prj_batch0000001',
      sessionId: 'ses_batch0000001',
      memberInstanceId: 'claude'
    });

    expect(listClaimedNativeAgentIngress(sqlite, 'recovery_batch001')).toEqual([
      {
        ingressSeq: 1,
        source: 'project',
        deliveryId: room.deliveryId,
        text: 'room update',
        createdAt: '2026-07-21T00:00:01.000Z',
        messageSeq,
        messageId: 'msg_batch0000001',
        sender: { kind: 'human', name: 'Human' }
      },
      {
        ingressSeq: 2,
        source: 'direct',
        deliveryId: direct.deliveryId,
        text: 'private update',
        createdAt: '2026-07-21T00:00:02.000Z',
        directMessageId: 'msg_batchdm00001',
        fromAgent: 'codex',
        peer: 'claude'
      }
    ]);
  } finally {
    store.close();
  }
});

test('inbox check consumes one mixed room and direct high-water batch exactly once', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    sqlite.exec(`
      INSERT INTO messages (id, transcript_target_id, role, text, type, stream_status, active, created_at)
      VALUES ('msg_CONSUME00001', 'ses_CONSUME00001', 'user', 'room body', 'text', 'complete', 1,
              '2026-07-22T00:00:01.000Z');
      INSERT INTO native_agent_direct_messages
        (id, session_id, mesh_session_id, from_agent, peer, text, created_at)
      VALUES ('msg_CONSUMEDM001', 'ses_CONSUME00001', 'mesh_sender00001', 'reviewer', 'builder',
              'direct body', '2026-07-22T00:00:02.000Z');
    `);
    const messageSeq = store.messageSeq('ses_CONSUME00001', 'msg_CONSUME00001');
    const room = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_CONSUME00001',
      memberInstanceId: 'builder',
      source: { kind: 'project', messageSeq, messageId: 'msg_CONSUME00001' }
    });
    const direct = enqueueNativeAgentIngressItem(sqlite, {
      projectId: 'prj_CONSUME00001',
      memberInstanceId: 'builder',
      source: { kind: 'direct', directMessageId: 'msg_CONSUMEDM001' }
    });

    expect(consumeNativeAgentPendingInbox(sqlite, 'prj_CONSUME00001', 'ses_CONSUME00001', 'builder')).toEqual([
      {
        source: 'project',
        ingressSeq: 1,
        messageSeq,
        deliveryId: room.deliveryId,
        createdAt: '2026-07-22T00:00:01.000Z',
        message: expect.objectContaining({ id: 'msg_CONSUME00001', text: 'room body' })
      },
      {
        source: 'direct',
        ingressSeq: 2,
        deliveryId: direct.deliveryId,
        createdAt: '2026-07-22T00:00:02.000Z',
        message: {
          id: 'msg_CONSUMEDM001',
          sessionId: 'ses_CONSUME00001',
          meshSessionId: 'mesh_sender00001',
          fromAgent: 'reviewer',
          peer: 'builder',
          text: 'direct body',
          createdAt: '2026-07-22T00:00:02.000Z'
        }
      }
    ]);
    expect(consumeNativeAgentPendingInbox(sqlite, 'prj_CONSUME00001', 'ses_CONSUME00001', 'builder')).toEqual([]);
    expect(sqlite.query('SELECT state FROM native_agent_ingress_items ORDER BY ingress_seq').all()).toEqual([
      { state: 'consumed' },
      { state: 'consumed' }
    ]);
  } finally {
    store.close();
  }
});

test('claimed prompt items preserve sender reply and attachment metadata', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    const [roomAttachment, directAttachment] = store.registerMessageAttachments([
      {
        id: 'att_ROOMFILE0001',
        sessionId: 'ses_METADATA0001',
        path: '/tmp/room.txt',
        name: 'room.txt',
        mime: 'text/plain',
        bytes: 11,
        preview: 'room',
        createdAt: '2026-07-22T03:00:00.000Z'
      },
      {
        id: 'att_DIRECTFILE01',
        sessionId: 'ses_METADATA0001',
        path: '/tmp/direct.txt',
        name: 'direct.txt',
        mime: 'text/plain',
        bytes: 13,
        preview: 'direct',
        createdAt: '2026-07-22T03:00:01.000Z'
      }
    ]);
    if (!roomAttachment || !directAttachment) throw new Error('missing attachment refs');
    store.insertMessage('msg_METAPARENT01', 'ses_METADATA0001', 'parent', '2026-07-22T02:59:00.000Z');
    store.insertMessage(
      'msg_METADATA0001',
      'ses_METADATA0001',
      'room with metadata',
      '2026-07-22T03:00:00.000Z',
      'assistant',
      {
        data: { agentName: 'reviewer', agentDisplayName: 'Reviewer', attachments: [roomAttachment] },
        replyToMessageId: 'msg_METAPARENT01'
      }
    );
    store.insertNativeAgentDirectMessage({
      id: 'msg_METADIRECT01',
      sessionId: 'ses_METADATA0001',
      meshSessionId: 'mesh_METASENDER01',
      fromAgent: 'reviewer',
      peer: 'builder',
      text: 'direct with metadata',
      attachments: [directAttachment],
      createdAt: '2026-07-22T03:00:01.000Z'
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_METADATA0001',
      memberInstanceId: 'builder',
      source: {
        kind: 'project',
        messageSeq: store.messageSeq('ses_METADATA0001', 'msg_METADATA0001'),
        messageId: 'msg_METADATA0001'
      }
    });
    store.enqueueNativeAgentIngressItem({
      projectId: 'prj_METADATA0001',
      memberInstanceId: 'builder',
      source: { kind: 'direct', directMessageId: 'msg_METADIRECT01' }
    });
    claimNativeAgentIngressBatch(sqlite, {
      id: 'deliv_METABATCH001',
      projectId: 'prj_METADATA0001',
      sessionId: 'ses_METADATA0001',
      memberInstanceId: 'builder'
    });

    expect(listClaimedNativeAgentIngress(sqlite, 'deliv_METABATCH001')).toEqual([
      expect.objectContaining({
        source: 'project',
        messageId: 'msg_METADATA0001',
        replyToMessageId: 'msg_METAPARENT01',
        sender: { kind: 'mesh-agent', id: 'reviewer', name: 'Reviewer' },
        attachments: [roomAttachment]
      }),
      expect.objectContaining({
        source: 'direct',
        directMessageId: 'msg_METADIRECT01',
        fromAgent: 'reviewer',
        peer: 'builder',
        attachments: [directAttachment]
      })
    ]);
  } finally {
    store.close();
  }
});

test('restart consumes accepted batches and releases only pre-acceptance claims', () => {
  const store = createStore();
  const sqlite = sqliteOf(store);
  try {
    store.insertMessage('msg_RESTART00001', 'ses_RESTART00001', 'accepted', new Date().toISOString(), 'user');
    store.insertMessage('msg_RESTART00002', 'ses_RESTART00001', 'not accepted', new Date().toISOString(), 'user');
    for (const [memberInstanceId, messageId] of [
      ['accepted-member', 'msg_RESTART00001'],
      ['released-member', 'msg_RESTART00002']
    ] as const) {
      store.enqueueNativeAgentIngressItem({
        projectId: 'prj_RESTART00001',
        memberInstanceId,
        source: {
          kind: 'project',
          messageSeq: store.messageSeq('ses_RESTART00001', messageId),
          messageId
        }
      });
    }
    claimNativeAgentIngressBatch(sqlite, {
      id: 'deliv_RESTARTA001',
      projectId: 'prj_RESTART00001',
      sessionId: 'ses_RESTART00001',
      memberInstanceId: 'accepted-member'
    });
    store.markNativeAgentIngressBatchDelivered('deliv_RESTARTA001');
    claimNativeAgentIngressBatch(sqlite, {
      id: 'deliv_RESTARTB001',
      projectId: 'prj_RESTART00001',
      sessionId: 'ses_RESTART00001',
      memberInstanceId: 'released-member'
    });

    expect(reconcileNativeAgentIngressAfterRestart(sqlite)).toEqual({ consumed: 1, released: 1 });
    expect(store.consumeNativeAgentPendingInbox('prj_RESTART00001', 'ses_RESTART00001', 'accepted-member')).toEqual([]);
    expect(
      store
        .consumeNativeAgentPendingInbox('prj_RESTART00001', 'ses_RESTART00001', 'released-member')
        .map((item) => item.message.text)
    ).toEqual(['not accepted']);
  } finally {
    store.close();
  }
});
