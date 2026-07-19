import { expect, test } from 'bun:test';
import { indexOfKey, overscanRowCount } from '@monad/ui/components/VirtualList';

test('indexOfKey finds a stable item key and reports a miss', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const getKey = (item: { id: string }) => item.id;

  expect({
    empty: indexOfKey([], getKey, 'a'),
    found: indexOfKey(items, getKey, 'b'),
    missing: indexOfKey(items, getKey, 'z')
  }).toEqual({
    empty: -1,
    found: 1,
    missing: -1
  });
});

test('overscan pixels become whole rows and never disable overscan', () => {
  expect([overscanRowCount(400, 96), overscanRowCount(600, 96), overscanRowCount(10, 96)]).toEqual([5, 7, 1]);
});
