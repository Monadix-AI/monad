import type { NativeCliSessionRow } from '@/store/db/index.ts';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createStore } from '@/store/db/index.ts';

let store: ReturnType<typeof createStore>;

beforeEach(() => {
  store = createStore();
});

afterEach(() => {
  store.close();
});

const row: NativeCliSessionRow = {
  id: 'ncli_1',
  projectSessionId: 'ses_project',
  agentName: 'codex',
  provider: 'codex' as const,
  workingPath: '/tmp/project',
  launchMode: 'pty' as const,
  state: 'running' as const,
  pid: 123,
  providerSessionRef: null,
  outputSnapshot: '',
  exitCode: null,
  startedAt: '2026-06-28T00:00:00.000Z',
  updatedAt: '2026-06-28T00:00:00.000Z',
  exitedAt: null
};

test('native CLI session lifecycle stores output snapshots and exit status', () => {
  store.upsertNativeCliSession(row);
  store.appendNativeCliOutput('ncli_1', 'hello', 32);
  store.updateNativeCliSessionRef('ncli_1', 'provider-session-1');
  store.closeNativeCliSession('ncli_1', '2026-06-28T00:00:01.000Z', 0);

  const rows = store.listNativeCliSessionsForProject('ses_project');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.outputSnapshot).toBe('hello');
  expect(rows[0]?.providerSessionRef).toBe('provider-session-1');
  expect(rows[0]?.state).toBe('exited');
  expect(rows[0]?.exitCode).toBe(0);
});

test('closeNativeCliSession does not overwrite terminal native CLI session state', () => {
  store.upsertNativeCliSession(row);
  store.closeNativeCliSession('ncli_1', '2026-06-28T00:00:01.000Z', null, 'stopped');
  store.closeNativeCliSession('ncli_1', '2026-06-28T00:00:02.000Z', 0, 'exited');

  const closed = store.getNativeCliSession('ncli_1');
  expect(closed?.state).toBe('stopped');
  expect(closed?.exitCode).toBeNull();
  expect(closed?.exitedAt).toBe('2026-06-28T00:00:01.000Z');
});

test('reconcileOrphanedNativeCliSessions marks live native CLI rows stopped on daemon restart', () => {
  store.upsertNativeCliSession(row);
  store.upsertNativeCliSession({ ...row, id: 'ncli_starting', state: 'starting', pid: null });
  store.upsertNativeCliSession({ ...row, id: 'ncli_done', state: 'exited', pid: 456, exitedAt: row.updatedAt });

  const reconciled = store.reconcileOrphanedNativeCliSessions(() => {});

  expect(reconciled).toBe(2);
  expect(store.getNativeCliSession('ncli_1')?.state).toBe('stopped');
  expect(store.getNativeCliSession('ncli_starting')?.state).toBe('stopped');
  expect(store.getNativeCliSession('ncli_done')?.state).toBe('exited');
});

test('provider session refs are unique per project session and provider when present', () => {
  store.upsertNativeCliSession({ ...row, id: 'ncli_1', providerSessionRef: 'provider-thread-1' });
  store.upsertNativeCliSession({ ...row, id: 'ncli_2', providerSessionRef: null });
  store.upsertNativeCliSession({ ...row, id: 'ncli_3', providerSessionRef: null });
  store.upsertNativeCliSession({
    ...row,
    id: 'ncli_other_project',
    projectSessionId: 'ses_other',
    providerSessionRef: 'provider-thread-1'
  });
  store.upsertNativeCliSession({
    ...row,
    id: 'ncli_other_provider',
    provider: 'claude-code',
    providerSessionRef: 'provider-thread-1'
  });

  expect(() =>
    store.upsertNativeCliSession({ ...row, id: 'ncli_duplicate', providerSessionRef: 'provider-thread-1' })
  ).toThrow();
});

test('deleteSession cleans up native CLI session rows', () => {
  store.insertSession({
    id: 'ses_project',
    title: 'project',
    ownerPrincipalId: 'prn_test',
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z'
  });
  store.upsertNativeCliSession(row);

  store.deleteSession('ses_project');

  expect(store.listNativeCliSessionsForProject('ses_project')).toHaveLength(0);
});
