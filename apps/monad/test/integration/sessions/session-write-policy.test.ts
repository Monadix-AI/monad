import type { OperationSource } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildHandlers, mockModel } from '../../helpers.ts';

const editorOrigin: OperationSource = {
  surface: 'editor',
  client: 'zed',
  transport: 'acp'
};

const webOrigin: OperationSource = {
  surface: 'web',
  client: 'monad-web',
  transport: 'http'
};

test('http control-plane send is accepted on an editor-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  const result = await h.session.send({ sessionId, text: '/help' });

  expect(result).toEqual({ accepted: true });
});

test('channel inline writes may continue an editor-origin interactive session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  await h.session.sendInline({ sessionId, text: '/help' }, () => {}, { transport: 'channel' });

  expect(h.store.listMessages(sessionId).map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'user', text: '/help' },
    expect.objectContaining({ role: 'assistant' })
  ]);
});

test('http send is accepted on a web-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'web', origin: webOrigin });

  const r = await h.session.send({ sessionId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('a session with no origin is writable', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'no-origin' });

  const r = await h.session.send({ sessionId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('http control-plane clients may branch an editor-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  const { sessionId: childId } = await h.session.branch({ id: sessionId, origin: webOrigin });

  expect(h.store.getSession(childId)?.origin).toEqual(webOrigin);
});

test('a branch with no origin is writable', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  const { sessionId: childId } = await h.session.branch({ id: sessionId });

  const r = await h.session.send({ sessionId: childId, text: '/help' });
  expect(r.accepted).toBe(true);
});
