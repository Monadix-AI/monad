// Access control: a session's stored write policy (origin.writableBy) governs which transports may
// write to it. The matrix is applied ONCE at creation to derive the policy; enforcement reads the
// stored policy, so it stays stable and is overridable per-session.

import type { SessionOrigin } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { sessionOriginExtSchema } from '@monad/protocol';

import { buildHandlers, mockModel } from '../../helpers.ts';

const editorOrigin: SessionOrigin = {
  surface: 'editor',
  client: 'zed',
  transport: 'acp',
  writableBy: ['acp'],
  branchableBy: ['acp']
};

const webOrigin: SessionOrigin = {
  surface: 'web',
  client: 'monad-web',
  transport: 'http',
  writableBy: ['http'],
  branchableBy: ['http']
};

test('http send/generate are rejected on an editor-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  await expect(h.session.send({ sessionId, text: '/help' })).rejects.toThrow(/cannot write/);
  await expect(h.session.generate({ sessionId, text: '/help' })).rejects.toThrow(/cannot write/);
});

test('the acp transport may write an editor-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  // sendInline defaults to the 'acp' transport; '/help' resolves as a command (no model turn).
  await h.session.sendInline({ sessionId, text: '/help' }, () => {});
});

test('the channel transport cannot write an editor-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  await expect(h.session.sendInline({ sessionId, text: '/help' }, () => {}, { transport: 'channel' })).rejects.toThrow(
    /cannot write/
  );
});

test('http send is accepted on a web-origin session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'web', origin: webOrigin });

  const r = await h.session.send({ sessionId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('a session with no origin is unrestricted', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'no-origin' });

  const r = await h.session.send({ sessionId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('branching an http-forkable editor session from http yields an http-writable child', async () => {
  const h = buildHandlers(mockModel());
  // Parent permits forks from http (override of the acp-only default).
  const { sessionId } = await h.session.create({
    title: 'editor',
    origin: { ...editorOrigin, branchableBy: ['acp', 'http'] }
  });

  // A fork initiated over http is a web session — the child's policy is the branching transport's,
  // NOT the parent's acp-only policy. (The parent origin stays reachable via parentSessionId.)
  const { sessionId: childId } = await h.session.branch({ id: sessionId, origin: webOrigin });

  const r = await h.session.send({ sessionId: childId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('http cannot branch an editor session under the default fork policy', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  await expect(h.session.branch({ id: sessionId, origin: webOrigin })).rejects.toThrow(/cannot branch/);
});

test('the acp transport may branch an editor session', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  // origin.transport = 'acp' (from editorOrigin) → matches the parent's branchableBy.
  const { sessionId: childId } = await h.session.branch({ id: sessionId, origin: editorOrigin });
  expect(childId).toMatch(/^ses_/);
});

test('a branch with no origin is unrestricted (not inherited from an editor parent)', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({ title: 'editor', origin: editorOrigin });

  const { sessionId: childId } = await h.session.branch({ id: sessionId });

  const r = await h.session.send({ sessionId: childId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('an explicit writableBy override widens access beyond the surface default', async () => {
  const h = buildHandlers(mockModel());
  const { sessionId } = await h.session.create({
    title: 'shared editor',
    origin: { ...editorOrigin, writableBy: ['acp', 'http'] } // collaborative override
  });

  const r = await h.session.send({ sessionId, text: '/help' });
  expect(r.accepted).toBe(true);
});

test('the open ext bag round-trips through create → get', async () => {
  const h = buildHandlers(mockModel());
  const ext = { theme: 'dark', tabId: 7, flags: ['a', 'b'] };
  const { sessionId } = await h.session.create({ title: 'web', origin: { ...webOrigin, ext } });

  const { session } = await h.session.get({ id: sessionId });
  expect(session.origin?.ext).toEqual(ext);
});

test('sessionOriginExtSchema rejects oversized / too-many-key ext', () => {
  expect(sessionOriginExtSchema.safeParse({ ok: 1 }).success).toBe(true);

  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]));
  expect(sessionOriginExtSchema.safeParse(tooMany).success).toBe(false);

  const tooBig = { blob: 'x'.repeat(5000) };
  expect(sessionOriginExtSchema.safeParse(tooBig).success).toBe(false);
});
