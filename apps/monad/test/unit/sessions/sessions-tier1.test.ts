import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';
import { sql } from 'drizzle-orm';

import { createStore } from '@/store/db/index.ts';

function fixtureSession(over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'test',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

test('updateSession merges fields and bumps updatedAt', async () => {
  const store = createStore();
  const s = fixtureSession({ title: 'old', updatedAt: '2000-01-01T00:00:00.000Z' });
  store.insertSession(s);

  const updated = store.updateSession(s.id, { title: 'new', state: 'paused', archived: true });
  expect(updated?.title).toBe('new');
  expect(updated?.state).toBe('paused');
  expect(updated?.archived).toBe(true);
  expect(updated?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  store.close();
});

test('listSessions filters by archived and state', () => {
  const store = createStore();
  store.insertSession(fixtureSession({ state: 'active', archived: false }));
  store.insertSession(fixtureSession({ state: 'completed', archived: false }));
  store.insertSession(fixtureSession({ state: 'active', archived: true }));

  expect(store.listSessions().length).toBe(3);
  expect(store.listSessions({ archived: false }).length).toBe(2);
  expect(store.listSessions({ archived: true }).length).toBe(1);
  expect(store.listSessions({ state: 'active' }).length).toBe(2);
  expect(store.listSessions({ state: 'active', archived: false }).length).toBe(1);
  store.close();
});

test('deleteSession cascades messages and events', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hi', new Date().toISOString(), 'user');
  store.appendEvents([
    {
      id: newId('evt'),
      sessionId: s.id,
      type: 'session.created',
      actorAgentId: null,
      payload: {},
      at: new Date().toISOString()
    }
  ]);

  expect(store.deleteSession(s.id)).toBe(true);
  expect(store.getSession(s.id)).toBeNull();
  expect(store.listMessages(s.id).length).toBe(0);
  expect(store.listEvents(s.id).length).toBe(0);
  expect(store.deleteSession(s.id)).toBe(false); // already gone
  store.close();
});

test('clearMessages removes messages + events but keeps the session', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  store.insertMessage(newId('msg'), s.id, 'hi', new Date().toISOString(), 'user');
  store.insertMessage(newId('msg'), s.id, 'hello', new Date().toISOString(), 'assistant');
  store.appendEvents([
    {
      id: newId('evt'),
      sessionId: s.id,
      type: 'session.created',
      actorAgentId: null,
      payload: {},
      at: new Date().toISOString()
    }
  ]);

  const cleared = store.clearMessages(s.id);
  expect(cleared).toBe(2); // 2 messages deleted
  expect(store.listMessages(s.id)).toHaveLength(0);
  expect(store.listEvents(s.id)).toHaveLength(0);
  expect(store.getSession(s.id)).not.toBeNull(); // session itself survives
  store.close();
});

test('messages carry the three-layer shape (text/type/data/stream/active)', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const id = newId('msg');
  store.insertMessage(id, s.id, 'Card: 3 results', new Date().toISOString(), 'assistant', {
    type: 'card',
    data: { items: [1, 2, 3] },
    streamStatus: 'complete'
  });

  const [m] = store.listMessages(s.id);
  expect(m?.text).toBe('Card: 3 results');
  expect(m?.type).toBe('card');
  expect(m?.data).toEqual({ items: [1, 2, 3] });
  expect(m?.stream.status).toBe('complete');
  expect(m?.active).toBe(true);
  store.close();
});

test('updateSession patches cwd and origin', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);

  const validOrigin = {
    surface: 'api' as const,
    client: 'test',
    transport: 'http' as const,
    writableBy: ['http' as const],
    branchableBy: ['http' as const]
  };
  const updated = store.updateSession(s.id, { cwd: '/home/user/project', origin: validOrigin });
  expect(updated?.cwd).toBe('/home/user/project');
  expect(updated?.origin).toMatchObject({ surface: 'api', transport: 'http' });

  // Clearing fields back to null works too.
  const cleared = store.updateSession(s.id, { cwd: null, origin: null });
  expect(cleared?.cwd).toBeUndefined();
  expect(cleared?.origin).toBeUndefined();
  store.close();
});

test('provenance returns empty for unknown id', () => {
  const store = createStore();
  expect(store.provenance('ses_DOESNOTEXIST')).toEqual({ ancestors: [], descendants: [] });
  store.close();
});

test('provenance returns root-first ancestors and all descendants', () => {
  const store = createStore();
  const root = fixtureSession();
  const child = fixtureSession({ parentSessionId: root.id });
  const grandchild = fixtureSession({ parentSessionId: child.id });
  const sibling = fixtureSession({ parentSessionId: root.id });
  store.insertSession(root);
  store.insertSession(child);
  store.insertSession(grandchild);
  store.insertSession(sibling);

  // Provenance of child: root is the only ancestor; grandchild + sibling are NOT its descendants.
  const fromChild = store.provenance(child.id);
  expect(fromChild.ancestors.map((s) => s.id)).toEqual([root.id]);
  expect(fromChild.descendants.map((s) => s.id)).toEqual([grandchild.id]);

  // Provenance of root: no ancestors; child, grandchild, sibling are all descendants.
  const fromRoot = store.provenance(root.id);
  expect(fromRoot.ancestors).toHaveLength(0);
  expect(fromRoot.descendants.map((s) => s.id).sort()).toEqual([child.id, grandchild.id, sibling.id].sort());
  store.close();
});

test('listMessages: active-only default, includeInactive, limit, before', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const ids = ['a', 'b', 'c'].map((t) => {
    const id = newId('msg');
    store.insertMessage(id, s.id, t, new Date().toISOString(), 'user');
    return id;
  });

  // soft-delete the last message (simulate restore/rewind)
  store.db.run(sql`UPDATE messages SET active = 0 WHERE id = ${ids[2]}`);

  expect(store.listMessages(s.id).map((m) => m.text)).toEqual(['a', 'b']);
  expect(store.listMessages(s.id, { includeInactive: true }).map((m) => m.text)).toEqual(['a', 'b', 'c']);
  expect(store.listMessages(s.id, { limit: 1 }).map((m) => m.text)).toEqual(['a']);
  expect(store.listMessages(s.id, { before: ids[1] as string }).map((m) => m.text)).toEqual(['a']);
  store.close();
});
