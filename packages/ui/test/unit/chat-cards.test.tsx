import { expect, test } from 'bun:test';

import { rawEventRecordsText } from '../../src/components/RawInspectableCard';

test('rawEventRecordsText preserves provider record order and exact text', () => {
  expect(
    rawEventRecordsText([
      { id: '1', text: '{"type":"call"}' },
      { id: '2', text: ' {"type":"result"} ' }
    ])
  ).toBe('{"type":"call"}\n {"type":"result"} ');
});
