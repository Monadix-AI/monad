import { expect, test } from 'bun:test';

import { scheduleDebouncedValue, serverSessionSearchArgs } from '../../src/features/shell/session-server-search.ts';

test('server session search trims the query and preserves archived scope', () => {
  expect(serverSessionSearchArgs('  runtime  ', false, 20)).toEqual({
    archived: false,
    limit: 20,
    offset: 0,
    query: 'runtime'
  });
  expect(serverSessionSearchArgs('archive', true, 200)).toEqual({
    archived: true,
    limit: 200,
    offset: 0,
    query: 'archive'
  });
  expect(serverSessionSearchArgs('   ', false, 20)).toBeNull();
});

test('debounced values commit after the delay and can be cancelled', async () => {
  const values: string[] = [];
  const cancelFirst = scheduleDebouncedValue('first', 10, (value) => values.push(value));
  cancelFirst();
  scheduleDebouncedValue('second', 10, (value) => values.push(value));

  expect(values).toEqual([]);
  await Bun.sleep(20);
  expect(values).toEqual(['second']);
});
