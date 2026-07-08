import type { Session } from '@monad/protocol';

import { afterAll, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@monad/protocol';

import { createStore } from '#/store/db/index.ts';

const DB_PATH = join(tmpdir(), `monad-store-e2e-${Date.now()}.sqlite`);

afterAll(() => {
  try {
    unlinkSync(DB_PATH);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(`${DB_PATH}-wal`);
  } catch {
    /* ok */
  }
  try {
    unlinkSync(`${DB_PATH}-shm`);
  } catch {
    /* ok */
  }
});

function fixtureSession(): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'e2e persistence test',
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

test('session written to a file-based store survives close and reopen', () => {
  const session = fixtureSession();

  const write = createStore({ path: DB_PATH });
  write.insertSession(session);
  write.close();

  const read = createStore({ path: DB_PATH });
  const found = read.getSession(session.id);
  read.close();

  expect(found).toEqual(session);
});

test('multiple sessions are all recoverable after reopen', () => {
  const a = fixtureSession();
  const b = fixtureSession();

  const write = createStore({ path: DB_PATH });
  write.insertSession(a);
  write.insertSession(b);
  write.close();

  const read = createStore({ path: DB_PATH });
  expect(read.getSession(a.id)?.title).toBe(a.title);
  expect(read.getSession(b.id)?.title).toBe(b.title);
  read.close();
});
