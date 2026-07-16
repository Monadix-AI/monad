import type { ViewItem } from '../../src/features/session/chat-view-items';

import { expect, test } from 'bun:test';

import { sessionTranscriptHeaderState } from '../../src/features/session/SessionTranscript.tsx';
import { sessionMessageOutlineItems } from '../../src/features/session/session-message-outline';

test('sessionMessageOutlineItems indexes only user messages against all rendered rows', () => {
  const items = [
    { id: 'u1', role: 'user', text: '  First\n question ' },
    { id: 'tool1', kind: 'tool', tool: 'read', input: {}, status: 'done' },
    { id: 'a1', role: 'assistant', text: 'Answer' },
    { id: 'u2', role: 'user', text: '' }
  ] as ViewItem[];

  expect(sessionMessageOutlineItems(items, (number) => `Message ${number}`, 'Time unavailable')).toEqual([
    {
      id: 'u1',
      index: 0,
      label: 'First question',
      preview: '  First\n question ',
      time: 'Time unavailable'
    },
    {
      id: 'u2',
      index: 3,
      label: 'Message 4',
      preview: '',
      time: 'Time unavailable'
    }
  ]);
});

test('session transcript shows loading before an empty-state placeholder', () => {
  expect(sessionTranscriptHeaderState(true, false, 0)).toBe('loading');
  expect(sessionTranscriptHeaderState(true, true, 0)).toBe('skeleton');
  expect(sessionTranscriptHeaderState(false, false, 0)).toBe('empty');
  expect(sessionTranscriptHeaderState(false, true, 1)).toBe('content');
});
