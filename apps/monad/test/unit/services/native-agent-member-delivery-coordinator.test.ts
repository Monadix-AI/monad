import { expect, test } from 'bun:test';

import { NativeAgentMemberDeliveryCoordinator } from '#/services/native-agent/member-delivery-coordinator.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('serializes gate creation with final native turn admission', async () => {
  const coordinator = new NativeAgentMemberDeliveryCoordinator();
  let gated = false;
  let starts = 0;
  const gateWrite = deferred();

  const creatingGate = coordinator.runExclusive('ses_gate00000001', 'builder', async () => {
    await gateWrite.promise;
    gated = true;
  });
  const admission = coordinator.admitTurn({
    sessionId: 'ses_gate00000001',
    memberInstanceId: 'builder',
    isGated: () => gated,
    start: () => {
      starts += 1;
      return Promise.resolve();
    }
  });

  gateWrite.resolve();
  await creatingGate;
  expect(await admission).toEqual({ admitted: false, reason: 'gated' });
  expect(starts).toBe(0);
});

test('does not pre-enqueue a successor while a native turn is active', async () => {
  const coordinator = new NativeAgentMemberDeliveryCoordinator();
  const turn = deferred();
  let starts = 0;
  const first = await coordinator.admitTurn({
    sessionId: 'ses_turn00000001',
    memberInstanceId: 'reviewer',
    isGated: () => false,
    start: () => {
      starts += 1;
      return turn.promise;
    }
  });
  const second = await coordinator.admitTurn({
    sessionId: 'ses_turn00000001',
    memberInstanceId: 'reviewer',
    isGated: () => false,
    start: () => {
      starts += 1;
      return Promise.resolve();
    }
  });

  expect(first).toMatchObject({ admitted: true });
  expect(second).toEqual({ admitted: false, reason: 'active' });
  expect(starts).toBe(1);

  turn.resolve();
  if (first.admitted) await first.completion;
  expect(
    await coordinator.admitTurn({
      sessionId: 'ses_turn00000001',
      memberInstanceId: 'reviewer',
      isGated: () => false,
      start: () => {
        starts += 1;
        return Promise.resolve();
      }
    })
  ).toMatchObject({ admitted: true });
  expect(starts).toBe(2);
});

test('runs one deferred recovery callback only after the active turn settles', async () => {
  const coordinator = new NativeAgentMemberDeliveryCoordinator();
  const turn = deferred();
  const calls: string[] = [];
  const admission = await coordinator.admitTurn({
    sessionId: 'ses_recovery0001',
    memberInstanceId: 'builder',
    isGated: () => false,
    start: () => turn.promise
  });

  expect(
    await coordinator.runWhenIdle('ses_recovery0001', 'builder', async () => {
      calls.push('recover');
    })
  ).toBe(false);
  expect(calls).toEqual([]);

  turn.resolve();
  if (admission.admitted) await admission.completion;
  await Promise.resolve();
  expect(calls).toEqual(['recover']);
});
