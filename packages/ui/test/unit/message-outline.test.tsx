import { expect, test } from 'bun:test';

import { activeMessageOutlineIds, type MessageOutlineItem } from '../../src/components/MessageOutline';

const outlineItems: MessageOutlineItem[] = [
  { id: 'u1', index: 0, label: 'First', time: '1 minute ago' },
  { id: 'u2', index: 3, label: 'Second', time: 'Now' },
  { id: 'u3', index: 6, label: 'Third', time: 'Now' }
];

test('activeMessageOutlineIds maps visible rows to the user-message sections they belong to', () => {
  // Rows 2-4 span the section opened by u1 (rows 0-2) and the one opened by u2 (rows 3-5).
  expect(activeMessageOutlineIds(outlineItems, { startIndex: 2, endIndex: 4 }, 8)).toEqual(new Set(['u1', 'u2']));
  expect(activeMessageOutlineIds(outlineItems, null, 8)).toEqual(new Set(['u3']));
});
