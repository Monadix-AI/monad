import type { IdempotencyKey, ProjectMember, SessionPlanTodo } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';

import {
  assignableRosterMembers,
  assignLanded,
  clampCursor,
  createIntentKeyMap,
  deleteLanded,
  findTodo,
  nextToggleStatus,
  resolveAssigneeName,
  sessionPlanAddText,
  toggleLanded
} from '../../src/shell/session-plan-model.ts';

function fixtureMember(overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    id: 'pmem_codex000001' as never,
    projectId: 'prj_100000000000' as never,
    profileId: 'codex',
    type: 'mesh-agent',
    displayName: 'Codex',
    customPrompt: null,
    launchOverrides: {},
    workingDirectoryOverride: null,
    lifecycle: 'enabled',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

function fixtureTodo(overrides: Partial<SessionPlanTodo> = {}): SessionPlanTodo {
  const origin = { source: { surface: 'im' as const, client: 'monad-tui', transport: 'channel' as const } };
  return {
    id: 'todo_100000000000' as never,
    sessionId: 'ses_100000000000' as never,
    text: 'Ship the panel',
    status: 'pending',
    version: 0,
    createdBy: origin,
    updatedBy: origin,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    ...overrides
  };
}

test('sessionPlanAddText trims and rejects whitespace-only input', () => {
  expect(sessionPlanAddText('  Ship the panel  ')).toBe('Ship the panel');
  expect(sessionPlanAddText('   ')).toBeNull();
  expect(sessionPlanAddText('')).toBeNull();
});

test('nextToggleStatus flips completed to pending and anything else to completed', () => {
  expect(nextToggleStatus('completed')).toBe('pending');
  expect(nextToggleStatus('pending')).toBe('completed');
  expect(nextToggleStatus('in_progress')).toBe('completed');
});

test('clampCursor keeps the cursor inside [0, length - 1], and 0 for an empty list', () => {
  expect(clampCursor(5, 3)).toBe(2);
  expect(clampCursor(-1, 3)).toBe(0);
  expect(clampCursor(1, 3)).toBe(1);
  expect(clampCursor(0, 0)).toBe(0);
});

test('assignableRosterMembers keeps only enabled members — the daemon rejects any other assignee', () => {
  const roster = [
    fixtureMember({ id: 'pmem_enabled000001' as never, lifecycle: 'enabled' }),
    fixtureMember({ id: 'pmem_disabled00001' as never, lifecycle: 'disabled' })
  ];
  expect(assignableRosterMembers(roster).map((m) => m.id)).toEqual(['pmem_enabled000001']);
});

test('resolveAssigneeName resolves a disabled/former member by id, not just enabled ones', () => {
  const roster = [
    fixtureMember({ id: 'pmem_left0000001' as never, displayName: 'Left member', lifecycle: 'disabled' })
  ];
  expect(resolveAssigneeName(roster, 'pmem_left0000001')).toBe('Left member');
  expect(resolveAssigneeName(roster, 'pmem_unknown00001')).toBeNull();
});

describe('createIntentKeyMap', () => {
  test('the same target with the same intent replays the same requestId', () => {
    const map = createIntentKeyMap<{ status: string }>(new Map());
    let minted = 0;
    const mint = () => `idem_${++minted}` as IdempotencyKey;
    const sameIntent = (a: { status: string }, b: { status: string }) => a.status === b.status;

    const first = map.keyFor('todo_a', { status: 'completed' }, sameIntent, mint);
    const retry = map.keyFor('todo_a', { status: 'completed' }, sameIntent, mint);

    expect(retry).toBe(first);
    expect(minted).toBe(1);
  });

  test("a different target never reuses another target's still-pending key, even with an identical intent shape", () => {
    const map = createIntentKeyMap<{ status: string }>(new Map());
    let minted = 0;
    const mint = () => `idem_${++minted}` as IdempotencyKey;
    const sameIntent = (a: { status: string }, b: { status: string }) => a.status === b.status;

    const keyA = map.keyFor('todo_a', { status: 'completed' }, sameIntent, mint);
    const keyB = map.keyFor('todo_b', { status: 'completed' }, sameIntent, mint);

    expect(keyB).not.toBe(keyA);
    expect(minted).toBe(2);
  });

  test('settle clears the slot, so the next call for that id mints a fresh key even with the same intent', () => {
    const map = createIntentKeyMap<{ status: string }>(new Map());
    let minted = 0;
    const mint = () => `idem_${++minted}` as IdempotencyKey;
    const sameIntent = (a: { status: string }, b: { status: string }) => a.status === b.status;

    const first = map.keyFor('todo_a', { status: 'completed' }, sameIntent, mint);
    map.settle('todo_a');
    const afterSettle = map.keyFor('todo_a', { status: 'completed' }, sameIntent, mint);

    expect(afterSettle).not.toBe(first);
    expect(minted).toBe(2);
  });

  test('a changed intent for the same target mints a fresh key', () => {
    const map = createIntentKeyMap<{ status: string }>(new Map());
    let minted = 0;
    const mint = () => `idem_${++minted}` as IdempotencyKey;
    const sameIntent = (a: { status: string }, b: { status: string }) => a.status === b.status;

    const toCompleted = map.keyFor('todo_a', { status: 'completed' }, sameIntent, mint);
    const toPending = map.keyFor('todo_a', { status: 'pending' }, sameIntent, mint);

    expect(toPending).not.toBe(toCompleted);
    expect(minted).toBe(2);
  });
});

describe('landed-outcome checks (self-heal after a non-409 error)', () => {
  test('toggleLanded is true only when the canonical todo actually shows the intended status', () => {
    expect(toggleLanded(fixtureTodo({ status: 'completed' }), 'completed')).toBe(true);
    expect(toggleLanded(fixtureTodo({ status: 'pending' }), 'completed')).toBe(false);
    expect(toggleLanded(undefined, 'completed')).toBe(false);
  });

  test('assignLanded treats a missing assigneeProjectMemberId as unassigned, and requires the todo to exist', () => {
    expect(
      assignLanded(fixtureTodo({ assigneeProjectMemberId: 'pmem_codex000001' as never }), 'pmem_codex000001')
    ).toBe(true);
    expect(assignLanded(fixtureTodo(), null)).toBe(true);
    expect(assignLanded(fixtureTodo({ assigneeProjectMemberId: 'pmem_codex000001' as never }), null)).toBe(false);
    expect(assignLanded(undefined, null)).toBe(false);
  });

  test('deleteLanded is true only when the todo no longer appears in the canonical list', () => {
    expect(deleteLanded(undefined)).toBe(true);
    expect(deleteLanded(fixtureTodo())).toBe(false);
  });
});

test('findTodo looks up by id and returns undefined when absent', () => {
  const todos = [fixtureTodo({ id: 'todo_100000000000' as never }), fixtureTodo({ id: 'todo_200000000000' as never })];
  expect(findTodo(todos, 'todo_200000000000' as never)?.id).toBe('todo_200000000000');
  expect(findTodo(todos, 'todo_missing000001' as never)).toBeUndefined();
});
