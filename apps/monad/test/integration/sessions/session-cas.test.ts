import type { Session } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

function fixtureSession(): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    projectId: undefined,
    model: undefined,
    reasoningEffort: undefined,
    cwd: undefined,
    origin: undefined,
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
    activityAt: now,
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
  store.close();
});
