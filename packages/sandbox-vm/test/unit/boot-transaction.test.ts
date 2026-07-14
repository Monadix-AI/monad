import { expect, test } from 'bun:test';

import { BootTransaction } from '../../src/runtime/boot-transaction.ts';

test('rollback releases acquired resources in reverse order and remains idempotent', async () => {
  const calls: string[] = [];
  const tx = new BootTransaction();
  tx.defer(async () => void calls.push('bundle'));
  tx.defer(async () => void calls.push('gvproxy'));

  await tx.rollback(new Error('readiness failed'));
  await tx.rollback(new Error('again'));

  expect(calls).toEqual(['gvproxy', 'bundle']);
});

test('commit transfers ownership and prevents rollback cleanup', async () => {
  let cleaned = false;
  const tx = new BootTransaction();
  tx.defer(async () => {
    cleaned = true;
  });

  tx.commit();
  await tx.rollback(new Error('late failure'));

  expect(cleaned).toBe(false);
});
