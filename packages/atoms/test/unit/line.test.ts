import { expect, test } from 'bun:test';

import { normalizeLineEvent } from '../../src/channels/line.ts';

test('LINE1: user source → dm keyed by user; group → group keyed by group', () => {
  expect(
    normalizeLineEvent({
      type: 'message',
      message: { type: 'text', id: '1', text: 'hi' },
      source: { type: 'user', userId: 'U1' }
    })
  ).toMatchObject({ chatId: 'U1', userId: 'U1', chatType: 'dm' });
  expect(
    normalizeLineEvent({
      type: 'message',
      message: { type: 'text', id: '1', text: 'hi' },
      source: { type: 'group', groupId: 'G1', userId: 'U1' }
    })
  ).toMatchObject({ chatId: 'G1', userId: 'U1', chatType: 'group' });
});

test('LINE2: non-text / non-message → null', () => {
  expect(
    normalizeLineEvent({
      type: 'message',
      message: { type: 'sticker', id: '1' },
      source: { type: 'user', userId: 'U1' }
    })
  ).toBe(null);
  expect(normalizeLineEvent({ type: 'follow', source: { type: 'user', userId: 'U1' } })).toBe(null);
});

test('LINE3: command parse', () => {
  expect(
    normalizeLineEvent({
      type: 'message',
      message: { type: 'text', id: '1', text: '/Reset' },
      source: { type: 'user', userId: 'U1' }
    })
  ).toMatchObject({ kind: 'command', command: 'reset' });
});
