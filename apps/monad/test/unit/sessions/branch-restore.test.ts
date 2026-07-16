import type { ModelRequest, ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

test('branch creates an independent session with a copied history snapshot', async () => {
  const d = buildHandlers(mockModel(['ok']));
  const { sessionId: parent } = await d.session.create({ title: 'parent' });
  await d.session.generate({ sessionId: parent, text: 'question' });
  const parentMessages = (await d.session.messages({ id: parent })).messages;
  const { sessionId: child } = await d.session.branch({ id: parent });

  const childMessages = (await d.session.messages({ id: child })).messages;
  expect(childMessages.map(({ role, text, type }) => ({ role, text, type }))).toEqual([
    { role: 'user', text: 'question', type: 'text' },
    { role: 'assistant', text: 'ok', type: 'text' },
    { role: 'assistant', text: '', type: 'branch_source' }
  ]);
  expect(childMessages.slice(0, 2).map((message) => message.id)).not.toEqual(
    parentMessages.map((message) => message.id)
  );
  expect(childMessages[2]?.data).toEqual({ sessionTitle: 'parent' });
});

test('branch rejects an assistant message target', async () => {
  const d = buildHandlers(mockModel(['answer']));
  const { sessionId } = await d.session.create({ title: 'parent' });
  await d.session.generate({ sessionId, text: 'question' });
  const assistant = (await d.session.messages({ id: sessionId })).messages.find(
    (message) => message.role === 'assistant'
  );
  if (!assistant) throw new Error('expected assistant message');

  await expect(d.session.branch({ id: sessionId, atMessageId: assistant.id })).rejects.toEqual(
    new HandlerError('invalid', 'branch target must be a user message')
  );
});

test('a branch ending at a user message can generate without duplicating the user turn', async () => {
  const d = buildHandlers(mockModel(['Alternative']));
  const { sessionId: parent } = await d.session.create({ title: 'parent' });
  await d.session.send({ generate: false, sessionId: parent, text: 'Try this' });
  const user = (await d.session.messages({ id: parent })).messages.find((message) => message.role === 'user');
  if (!user) throw new Error('expected a user message');
  const { sessionId: child } = await d.session.branch({ id: parent, atMessageId: user.id });

  await d.session.sendInline({ continueFromHistory: true, sessionId: child, text: '' }, () => {}, {
    transport: 'http'
  });

  const childMessages = (await d.session.messages({ id: child })).messages;
  expect(childMessages.map(({ role, text, type }) => ({ role, text, type }))).toEqual([
    { role: 'user', text: 'Try this', type: 'text' },
    { role: 'assistant', text: '', type: 'branch_source' },
    { role: 'assistant', text: 'Alternative', type: 'text' }
  ]);
  expect(childMessages.map((message) => message.includeInContext === false)).toEqual([false, true, false]);
  expect(childMessages[1]?.data).toEqual({ sessionTitle: 'parent' });
});

test('branching a snapshot replaces its UI boundary instead of copying branch metadata', async () => {
  const d = buildHandlers(mockModel(['answer']));
  const { sessionId: root } = await d.session.create({ title: 'root' });
  await d.session.generate({ sessionId: root, text: 'question' });
  const { sessionId: child } = await d.session.branch({ id: root, title: 'child' });
  const { sessionId: grandchild } = await d.session.branch({ id: child, title: 'grandchild' });

  const boundaries = (await d.session.messages({ id: grandchild })).messages.filter(
    (message) => message.type === 'branch_source'
  );
  expect(boundaries).toHaveLength(1);
  expect(boundaries[0]?.data).toEqual({ sessionTitle: 'child' });
});

test('restore soft-deletes from a user message onward and bumps restore_count', async () => {
  const d = buildHandlers(mockModel(['A']));
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'first' }); // user:first, assistant:A
  await d.session.generate({ sessionId, text: 'second' }); // user:second, assistant:A

  const before = await d.session.messages({ id: sessionId });
  expect(before.messages.length).toBe(4);
  const secondUser = before.messages.find((m) => m.role === 'user' && m.text === 'second');
  if (!secondUser) throw new Error('expected a "second" user message');

  const res = await d.session.restore({ id: sessionId, toMessageId: secondUser.id });
  expect(res.restoredCount).toBe(2); // user:second + assistant:A

  const after = await d.session.messages({ id: sessionId });
  expect(after.messages.map((m) => m.text)).toEqual(['first', 'A']);
  // soft-deleted rows still retrievable for audit
  const all = await d.session.messages({ id: sessionId, includeInactive: true });
  expect(all.messages.length).toBe(4);
  expect((await d.session.get({ id: sessionId })).session.restoreCount).toBe(1);
});

test('restore aborts an active generation before discarding the rewound turn', async () => {
  let signalSeen: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const model: ModelRouter = {
    async *stream(req: ModelRequest) {
      signalSeen = req.signal;
      markStarted?.();
      yield { type: 'text' as const, token: 'partial' };
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) return resolve();
        req.signal?.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 250);
      });
    },
    async complete(): Promise<ModelResult> {
      return { finishReason: 'stop', text: 'kept' };
    }
  };
  const d = buildHandlers(model);
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'first' });
  await d.session.send({ sessionId, text: 'rewind me' });
  await started;
  const target = (await d.session.messages({ id: sessionId })).messages.find(
    (message) => message.role === 'user' && message.text === 'rewind me'
  );
  if (!target) throw new Error('expected active user message');

  const result = await d.session.restore({ id: sessionId, toMessageId: target.id });

  expect(signalSeen?.aborted).toBe(true);
  expect(result.restoredCount).toBe(2);
  expect((await d.session.messages({ id: sessionId })).messages.map((message) => message.text)).toEqual([
    'first',
    'kept'
  ]);
});

test('restore rejects a non-user target message', async () => {
  const d = buildHandlers(mockModel(['A']));
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'hi' });
  const msgs = (await d.session.messages({ id: sessionId })).messages;
  const assistant = msgs.find((m) => m.role === 'assistant');
  if (!assistant) throw new Error('expected an assistant message');
  await expect(d.session.restore({ id: sessionId, toMessageId: assistant.id })).rejects.toBeInstanceOf(HandlerError);
});

test('restore rejects an unknown message id', async () => {
  const d = buildHandlers(mockModel(['A']));
  const { sessionId } = await d.session.create({ title: 't' });
  await expect(d.session.restore({ id: sessionId, toMessageId: 'msg_nope00000000' })).rejects.toBeInstanceOf(
    HandlerError
  );
});

test('branch snapshot is truncated at the branch point and unaffected by later parent restore', async () => {
  const d = buildHandlers(mockModel(['R']));
  const { sessionId: parent } = await d.session.create({ title: 'p' });
  await d.session.generate({ sessionId: parent, text: 'p1' }); // user:p1, assistant:R
  await d.session.generate({ sessionId: parent, text: 'p2' }); // user:p2, assistant:R

  const parentMsgs = (await d.session.messages({ id: parent })).messages;
  const cut = parentMsgs.find((m) => m.role === 'user' && m.text === 'p2');
  if (!cut) throw new Error('expected the second parent user message');

  const { sessionId: child } = await d.session.branch({ id: parent, atMessageId: cut.id });
  await d.session.generate({ sessionId: child, text: 'c1' }); // user:c1, assistant:R
  await d.session.restore({ id: parent, toMessageId: cut.id });

  const snapshot = (await d.session.messages({ id: child })).messages.map((m) => m.text);
  expect(snapshot).toEqual(['p1', 'R', 'p2', '', 'c1', 'R']);
});

test('branch copies the snapshot tool calls’ spilled raw outputs, so the child’s recovery handles resolve', async () => {
  const d = buildHandlers(mockModel(['ok', 'ok']));
  const { sessionId: parent } = await d.session.create({ title: 'p' });
  await d.session.generate({ sessionId: parent, text: 'q1' });
  const branchPoint = (await d.session.messages({ id: parent })).messages.find((m) => m.role === 'user');
  if (!branchPoint) throw new Error('expected a user message');
  // A tool_call row inside the snapshot with a spilled raw output…
  d.store.insertMessage(newId('msg'), parent, '', new Date().toISOString(), 'assistant', {
    type: 'tool_call',
    data: { toolCallId: 'call_in', toolName: 'file_read', input: {} }
  });
  d.store.saveToolRawOutput(parent, 'call_in', 'FULL BYTES');
  // …and one that will fall OUTSIDE the branch point (branching at the first user message).
  d.store.saveToolRawOutput(parent, 'call_out', 'NOT CLONED');

  const { sessionId: child } = await d.session.branch({ id: parent });
  expect(d.store.getToolRawOutput(child, 'call_in')).toBe('FULL BYTES');
  expect(d.store.getToolRawOutput(child, 'call_out')).toBeNull(); // presence-ok: no tool_call row references it, so no copy
  expect(d.store.getToolRawOutput(parent, 'call_in')).toBe('FULL BYTES'); // parent's copy untouched
});
