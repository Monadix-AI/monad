import { expect, test } from 'bun:test';
import { initialFirstItemIndexState, nextFirstItemIndexState } from '@monad/ui/hooks/use-first-item-index';

interface Row {
  id: string;
}

const rowId = (row: Row) => row.id;

test('inverse pagination updates the absolute index in the same row transition', () => {
  const initialRows = [{ id: 'message-20' }, { id: 'message-21' }];
  const prependedRows = [{ id: 'group-18' }, { id: 'message-19' }, ...initialRows];
  const replacementRows = [{ id: 'other-1' }, { id: 'other-2' }];
  const initial = nextFirstItemIndexState(initialFirstItemIndexState, initialRows, rowId);
  const prepended = nextFirstItemIndexState(initial, prependedRows, rowId);
  const unchanged = nextFirstItemIndexState(prepended, prependedRows, rowId);
  const replacement = nextFirstItemIndexState(unchanged, replacementRows, rowId);

  expect([initial, prepended, unchanged, replacement]).toEqual([
    { firstId: 'message-20', value: 1_000_000 },
    { firstId: 'group-18', value: 999_998 },
    { firstId: 'group-18', value: 999_998 },
    { firstId: 'other-1', value: 1_000_000 }
  ]);
});
