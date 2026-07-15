import type { Session, SessionId, WorkplaceProject } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';
import { sql } from 'drizzle-orm';

import { createStore } from '#/store/db/index.ts';
import { sessions, tasks, workplaceProjects } from '#/store/db/schema.ts';

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

function fixtureProject(over: Partial<WorkplaceProject> = {}): WorkplaceProject {
  const now = new Date().toISOString();
  return {
    id: newId('prj'),
    title: 'project',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    archived: false,
    memberTemplates: [],
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

test('session model and effort persist through the shared model column', () => {
  const store = createStore();
  const session = fixtureSession({ model: 'openrouter:gpt-5', reasoningEffort: 'high' });
  store.insertSession(session);

  expect(store.db.select({ model: sessions.model }).from(sessions).get()?.model).toBe(
    '{"model":"openrouter:gpt-5","effort":"high"}'
  );
  expect(store.getSession(session.id)).toMatchObject({ model: 'openrouter:gpt-5', reasoningEffort: 'high' });

  store.updateSession(session.id, { reasoningEffort: null });
  expect(store.db.select({ model: sessions.model }).from(sessions).get()?.model).toBe('{"model":"openrouter:gpt-5"}');
  expect(store.getSession(session.id)).toMatchObject({ model: 'openrouter:gpt-5' });
  expect(store.getSession(session.id)?.reasoningEffort).toBeUndefined();
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

test('workplace projects use explicit project storage instead of agent sessions', () => {
  const store = createStore();
  const project = fixtureProject({
    title: 'project',
    origin: {
      surface: 'web',
      client: 'workplace',
      transport: 'http',
      writableBy: ['http'],
      branchableBy: ['http']
    },
    cwd: '/tmp/workplace-project'
  });
  const agentSession = fixtureSession({ title: 'agent', agentIds: [newId('agt')] });
  const now = new Date().toISOString();

  store.insertWorkplaceProject(project);
  store.insertSession(agentSession);
  store.insertTask({
    id: newId('tsk'),
    sessionId: agentSession.id,
    title: 'session task',
    assigneeAgentId: null,
    dependsOn: [],
    state: 'pending',
    version: 0,
    createdAt: now,
    updatedAt: now
  });
  store.setMemory(agentSession.id, 'ctx:summary', JSON.stringify({ summary: 'session memory' }));

  expect(store.db.select().from(sessions).all()).toHaveLength(1);
  expect(store.db.select().from(workplaceProjects).all()).toHaveLength(1);
  expect(store.getWorkplaceProject(project.id)?.title).toBe('project');
  expect(store.listSessions().map((session) => session.id)).not.toContain(project.id);
  expect(store.listWorkplaceProjects().map((candidate) => candidate.id)).toContain(project.id);

  const updated = store.updateWorkplaceProject(project.id, { title: 'renamed', archived: true });
  expect(updated?.title).toBe('renamed');
  expect(updated?.archived).toBe(true);
  expect(store.countSessions({ archived: true })).toBe(0);
  expect(store.countWorkplaceProjects({ archived: true })).toBe(1);

  expect(store.deleteWorkplaceProject(project.id)).toBe(true);
  expect(store.db.select().from(tasks).all()).toHaveLength(1);
  store.close();
});

test('deleteSession cascades session-owned project data', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  store.insertMessage(newId('msg'), s.id, 'hi', new Date().toISOString(), 'user');
  store.insertTask({
    id: newId('tsk'),
    sessionId: s.id,
    title: 'task',
    assigneeAgentId: null,
    dependsOn: [],
    state: 'pending',
    version: 0,
    createdAt: now,
    updatedAt: now
  });
  store.setMemory(s.id, 'ctx:summary', JSON.stringify({ summary: 'delete me' }));
  store.setActiveSession({
    channelId: 'discord',
    conversationKey: 'thread-1',
    sessionId: s.id,
    principalId: s.ownerPrincipalId,
    label: 'project'
  });
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
  store.close();
});

test('clearMessages removes Workplace Project transcript data and keeps the project', () => {
  const store = createStore();
  const project = fixtureProject({ title: 'project', updatedAt: '2000-01-01T00:00:00.000Z' });
  store.insertWorkplaceProject(project);
  store.insertMessage(newId('msg'), project.id, 'hi', new Date().toISOString(), 'user');
  store.appendEvents([
    {
      id: newId('evt'),
      sessionId: project.id as unknown as SessionId,
      type: 'session.created',
      actorAgentId: null,
      payload: {},
      at: new Date().toISOString()
    }
  ]);
  store.setMemory(project.id, 'ctx:summary', JSON.stringify({ summary: 'delete me' }));

  const cleared = store.clearMessages(project.id);
  expect(cleared).toBe(1);
  expect(store.getWorkplaceProject(project.id)?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  store.close();
});

test('file observations upsert and follow session cleanup', () => {
  const store = createStore();
  const first = fixtureSession();
  const second = fixtureSession();
  const now = new Date().toISOString();
  store.insertSession(first);
  store.insertSession(second);
  store.insertMessage(newId('msg'), first.id, 'first', now, 'user');
  store.insertMessage(newId('msg'), second.id, 'second', now, 'user');
  store.recordFileObservation(first.id, {
    path: '/tmp/a.txt',
    hash: 'hash-a1',
    coverage: 'full',
    observedAt: now,
    toolCallId: 'call_1'
  });
  store.recordFileObservation(first.id, {
    path: '/tmp/a.txt',
    hash: 'hash-a2',
    coverage: 'full',
    observedAt: now,
    toolCallId: 'call_2'
  });
  store.recordFileObservation(second.id, {
    path: '/tmp/a.txt',
    hash: 'hash-b',
    coverage: 'full',
    observedAt: now
  });

  expect(store.getFileObservation(first.id, '/tmp/a.txt')).toMatchObject({ hash: 'hash-a2', toolCallId: 'call_2' });
  expect(store.clearMessages(first.id)).toBe(1);
  expect(store.getSession(first.id)?.id).toBe(first.id);
  expect(store.getFileObservation(first.id, '/tmp/a.txt')).toBeNull();
  expect(store.getFileObservation(second.id, '/tmp/a.txt')?.hash).toBe('hash-b');
  expect(store.deleteSession(second.id)).toBe(true);
  expect(store.getFileObservation(second.id, '/tmp/a.txt')).toBeNull();
  store.close();
});

test('restore clears file observations when the rewound range contains a newer observation', () => {
  const store = createStore();
  const s = fixtureSession();
  const before = '2026-01-01T00:00:00.000Z';
  const targetAt = '2026-01-01T00:01:00.000Z';
  const after = '2026-01-01T00:02:00.000Z';
  store.insertSession(s);
  const first = newId('msg');
  const second = newId('msg');
  store.insertMessage(first, s.id, 'first', before, 'assistant');
  store.insertMessage(second, s.id, 'second', targetAt, 'user');
  store.recordFileObservation(s.id, {
    path: '/tmp/older.txt',
    hash: 'hash-older',
    coverage: 'full',
    observedAt: before,
    toolCallId: 'call_older'
  });
  store.recordFileObservation(s.id, {
    path: '/tmp/newer.txt',
    hash: 'hash-newer',
    coverage: 'full',
    observedAt: after,
    toolCallId: 'call_newer'
  });

  store.restoreMessages(s.id, second);
  expect(store.listMessages(s.id)).toHaveLength(1);
  expect(store.getFileObservation(s.id, '/tmp/older.txt')).toBeNull();
  expect(store.getFileObservation(s.id, '/tmp/newer.txt')).toBeNull();
  store.close();
});

test('restore preserves file observations when no observation falls inside the rewound range', () => {
  const store = createStore();
  const s = fixtureSession();
  const before = '2026-01-01T00:00:00.000Z';
  const targetAt = '2026-01-01T00:01:00.000Z';
  store.insertSession(s);
  const first = newId('msg');
  const second = newId('msg');
  store.insertMessage(first, s.id, 'first', before, 'assistant');
  store.insertMessage(second, s.id, 'second', targetAt, 'user');
  store.recordFileObservation(s.id, {
    path: '/tmp/older.txt',
    hash: 'hash-older',
    coverage: 'full',
    observedAt: before,
    toolCallId: 'call_older'
  });

  store.restoreMessages(s.id, second);
  expect(store.listMessages(s.id).map((m) => m.id)).toEqual([first]);
  expect(store.getFileObservation(s.id, '/tmp/older.txt')).toMatchObject({ hash: 'hash-older' });
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
