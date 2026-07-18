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
    { anchors: ['message-20', 'message-21'], firstId: 'message-20', value: 1_000_000 },
    {
      anchors: ['group-18', 'message-19', 'message-20', 'message-21'],
      firstId: 'group-18',
      value: 999_998
    },
    {
      anchors: ['group-18', 'message-19', 'message-20', 'message-21'],
      firstId: 'group-18',
      value: 999_998
    },
    { anchors: ['other-1', 'other-2'], firstId: 'other-1', value: 1_000_000 }
  ]);
});

test('inverse pagination keeps its absolute index when the previous boundary row is regrouped away', () => {
  const initialRows = [{ id: 'old-boundary' }, { id: 'anchor' }, { id: 'tail' }];
  const regroupedRows = [{ id: 'older-a' }, { id: 'older-b' }, { id: 'anchor' }, { id: 'tail' }];
  const initial = nextFirstItemIndexState(initialFirstItemIndexState, initialRows, rowId);
  const regrouped = nextFirstItemIndexState(initial, regroupedRows, rowId);

  expect(regrouped).toEqual({
    anchors: ['older-a', 'older-b', 'anchor', 'tail'],
    firstId: 'older-a',
    value: 999_999
  });
});
