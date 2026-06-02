import { expect, test } from 'bun:test';

import { MESSAGE_SPEAKER_WIDTH, messageContentWidth } from '../../src/components/message-layout.ts';

test('message content cannot consume the reserved speaker column', () => {
  expect(MESSAGE_SPEAKER_WIDTH).toBeGreaterThanOrEqual(12);
  expect(messageContentWidth(80)).toBe(80 - MESSAGE_SPEAKER_WIDTH);
  expect(messageContentWidth(4)).toBe(1);
});
