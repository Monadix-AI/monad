import { expect, test } from 'bun:test';

import { mapWithConcurrency } from '../../lib/map-with-concurrency.ts';

test('maps in input order while limiting active tasks', async () => {
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrency([30, 10, 20, 5], 2, async (delay, index) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(delay);
    active -= 1;
    return `${index}:${delay}`;
  });

  expect({ maxActive, results }).toEqual({
    maxActive: 2,
    results: ['0:30', '1:10', '2:20', '3:5']
  });
});

test('rejects an invalid concurrency before running tasks', async () => {
  let executions = 0;

  const result = mapWithConcurrency([1], 0, async () => {
    executions += 1;
    return 1;
  });

  expect({ executions, error: await result.catch((error: Error) => error.message) }).toEqual({
    executions: 0,
    error: 'invalid concurrency: 0'
  });
});
