import type { Session, Task } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '@/store/db/index.ts';

function fixtureSession(): Session {
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
    updatedAt: now
  };
}

test('round-trips a session via in-memory store', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  expect(store.getSession(s.id)).toEqual(s);
  store.close();
});

test('getSession returns null for unknown id', () => {
  const store = createStore();
  expect(store.getSession('ses_UNKNOWN')).toBeNull();
  store.close();
});

test('CAS transition succeeds once, then loses the race on stale version', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  const task: Task = {
    id: newId('tsk'),
    sessionId: s.id,
    title: 't',
    assigneeAgentId: null,
    dependsOn: [],
    state: 'pending',
    version: 0,
    createdAt: now,
    updatedAt: now
  };
  store.insertTask(task);

  expect(store.casTaskState(task.id, 0, 'running', now)).toBe(true);
  // stale version -> lost race -> returns false, state unchanged
  expect(store.casTaskState(task.id, 0, 'succeeded', now)).toBe(false);
  store.close();
});

test('CAS transition advances version monotonically', () => {
  const store = createStore();
  const s = fixtureSession();
  store.insertSession(s);
  const now = new Date().toISOString();
  const task: Task = {
    id: newId('tsk'),
    sessionId: s.id,
    title: 't',
    assigneeAgentId: null,
    dependsOn: [],
    state: 'pending',
    version: 0,
    createdAt: now,
    updatedAt: now
  };
  store.insertTask(task);

  expect(store.casTaskState(task.id, 0, 'running', now)).toBe(true);
  // version is now 1
  expect(store.casTaskState(task.id, 1, 'succeeded', now)).toBe(true);
  store.close();
});
