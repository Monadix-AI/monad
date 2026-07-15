import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

test('branch creates a child with parentSessionId set; provenance links them', async () => {
  const d = buildHandlers(mockModel(['ok']));
  const { sessionId: parent } = await d.session.create({ title: 'parent' });
  const { sessionId: child } = await d.session.branch({ id: parent });

  const childSession = (await d.session.get({ id: child })).session;
  expect(childSession.parentSessionId).toBe(parent);

  const prov = await d.session.provenance({ id: child });
  expect(prov.ancestors.map((s) => s.id)).toEqual([parent]);
  expect(prov.self.id).toBe(child);

  const parentProv = await d.session.provenance({ id: parent });
  expect(parentProv.descendants.map((s) => s.id)).toContain(child);
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
    { role: 'assistant', text: '', type: 'branch_source' },
    { role: 'user', text: 'Try this', type: 'text' },
    { role: 'assistant', text: 'Alternative', type: 'text' }
  ]);
  expect(childMessages.slice(0, 2).map((message) => message.includeInContext)).toEqual([false, false]);
  expect(childMessages[0]?.data).toEqual({ messageId: user.id, sessionId: parent });
  expect(
    (await d.session.messages({ id: child, includeAncestors: true })).messages.map(({ role, text }) => ({ role, text }))
  ).toEqual([
    { role: 'user', text: 'Try this' },
    { role: 'assistant', text: '' },
    { role: 'user', text: 'Try this' },
    { role: 'assistant', text: 'Alternative' }
  ]);
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

test('messages(includeAncestors) replays parent history truncated at the branch point', async () => {
  const d = buildHandlers(mockModel(['R']));
  const { sessionId: parent } = await d.session.create({ title: 'p' });
  await d.session.generate({ sessionId: parent, text: 'p1' }); // user:p1, assistant:R
  await d.session.generate({ sessionId: parent, text: 'p2' }); // user:p2, assistant:R

  const parentMsgs = (await d.session.messages({ id: parent })).messages;
  const cut = parentMsgs.find((m) => m.role === 'assistant'); // first assistant (after p1)
  if (!cut) throw new Error('expected an assistant message in parent');

  const { sessionId: child } = await d.session.branch({ id: parent, atMessageId: cut.id });
  await d.session.generate({ sessionId: child, text: 'c1' }); // user:c1, assistant:R

  const own = (await d.session.messages({ id: child })).messages.map((m) => m.text);
  expect(own).toEqual(['', 'R', 'c1', 'R']);

  const withAncestors = (await d.session.messages({ id: child, includeAncestors: true })).messages.map((m) => m.text);
  // parent truncated at first assistant (p1, R) + source reference + copied branch target + child's own (c1, R)
  expect(withAncestors).toEqual(['p1', 'R', '', 'R', 'c1', 'R']);
});
