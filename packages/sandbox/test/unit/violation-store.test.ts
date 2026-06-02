import type { SandboxViolation } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { SandboxViolationStore } from '../../src/violation-store.ts';

function violation(operation: string): SandboxViolation {
  return {
    kind: 'runtime',
    operation,
    runId: 'run-1',
    timestamp: '2026-07-14T00:00:00.000Z'
  };
}

test('retains the newest events while total remains monotonic across clear', () => {
  const store = new SandboxViolationStore(3);
  for (let i = 0; i < 5; i++) store.append(violation(`op-${i}`));

  expect(store.snapshot()).toEqual({
    total: 5,
    events: [violation('op-2'), violation('op-3'), violation('op-4')]
  });

  store.clear();

  expect(store.snapshot()).toEqual({ total: 5, events: [] });
});

test('snapshots and subscriber payloads are defensive copies', () => {
  const store = new SandboxViolationStore(2);
  const snapshots: ReturnType<typeof store.snapshot>[] = [];
  const unsubscribe = store.subscribe((snapshot) => snapshots.push(snapshot));
  store.append(violation('first'));
  unsubscribe();
  store.append(violation('second'));

  const subscribedEvent = snapshots[0]?.events[0];
  if (!subscribedEvent) throw new Error('subscriber did not receive the appended event');
  subscribedEvent.operation = 'mutated';
  const snapshot = store.snapshot();
  snapshot.events.length = 0;

  expect(store.snapshot().events.map((event) => event.operation)).toEqual(['first', 'second']);
  expect(snapshots).toHaveLength(1);
});
