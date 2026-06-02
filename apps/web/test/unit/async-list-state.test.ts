import { expect, test } from 'bun:test';

import { isResolvedEmptyList } from '../../src/lib/async-list-state.ts';

test('empty placeholders require a completed initial load', () => {
  expect([
    isResolvedEmptyList({ isLoading: true, itemCount: 0 }),
    isResolvedEmptyList({ isLoading: false, itemCount: 0 }),
    isResolvedEmptyList({ isLoading: false, itemCount: 1 })
  ]).toEqual([false, true, false]);
});
