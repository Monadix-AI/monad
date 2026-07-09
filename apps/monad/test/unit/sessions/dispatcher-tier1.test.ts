import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { createStore } from '#/store/db/index.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

test('sessionGet throws INVALID_PARAMS for an unknown session', async () => {
  const d = buildHandlers(mockModel(['hi']));
  await expect(d.session.get({ id: 'ses_nope00000000' as SessionId })).rejects.toBeInstanceOf(HandlerError);
  try {
    await d.session.get({ id: 'ses_nope00000000' as SessionId });
  } catch (e) {
    expect((e as HandlerError).kind).toBe('invalid');
  }
});

test('sessionUpdate rejects an illegal state transition', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.update({ id: sessionId, state: 'completed' }); // active -> completed (ok, terminal)
  await expect(d.session.update({ id: sessionId, state: 'active' })).rejects.toMatchObject({
    kind: 'invalid'
  });
});

test('sessionUpdate renames + archives and returns the new session', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 'old' });
  const { session } = await d.session.update({ id: sessionId, title: 'new', archived: true });
  expect(session.title).toBe('new');
  expect(session.archived).toBe(true);
});

test('sessionDelete removes the session', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 't' });
  expect(await d.session.delete({ id: sessionId })).toEqual({ deleted: true });
  await expect(d.session.get({ id: sessionId })).rejects.toBeInstanceOf(HandlerError);
});

test('sessionDelete cleans up orphaned session_members rows', async () => {
  const store = createStore();
  const d = buildHandlers(mockModel(['hi']), undefined, { store });
  const { sessionId } = await d.session.create({ title: 't' });
  store.insertSessionMember({
    sessionId,
    memberId: 'pmem_codex_a',
    templateId: 'pmem_codex_a',
    type: 'external-agent',
    data: { name: 'codex', instanceId: 'pmem_codex_a' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  expect(store.listSessionMembers(sessionId)).toHaveLength(1);
  await d.session.delete({ id: sessionId });
  expect(store.listSessionMembers(sessionId)).toEqual([]);
});

test('sessionAbort reports false when nothing is in flight', async () => {
  const d = buildHandlers(mockModel(['hi']));
  const { sessionId } = await d.session.create({ title: 't' });
  expect(await d.session.abort({ id: sessionId })).toEqual({ aborted: false });
});

test('sessionMessages returns persisted history after a block turn', async () => {
  const d = buildHandlers(mockModel(['Hello', ' world']));
  const { sessionId } = await d.session.create({ title: 't' });
  await d.session.generate({ sessionId, text: 'hi' });
  const { messages } = await d.session.messages({ id: sessionId });
  expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(messages[1]?.text).toBe('Hello world');
});
