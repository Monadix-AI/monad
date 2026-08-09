import type { ViewItem } from '../../src/features/session/chat-view-items';

import { expect, test } from 'bun:test';

import { isCompactSessionEvent, sessionTranscriptHeaderState } from '../../src/features/session/SessionTranscript.tsx';
import {
  completeSessionMessageOutlineItems,
  sessionMessageOutlineItems
} from '../../src/features/session/session-message-outline';

const formatTime = (iso: string | undefined) => (iso ? `at:${iso}` : 'Time unavailable');

test('reasoning-only and tool rows use the compact event rhythm', () => {
  expect(
    [
      { id: 'reasoning', reasoning: 'Thinking', role: 'assistant', text: '' },
      { id: 'tool', kind: 'tool', status: 'ok', tool: 'read' },
      { id: 'answer', role: 'assistant', text: 'Done' },
      { id: 'user', role: 'user', text: 'Question' }
    ].map((item) => isCompactSessionEvent(item as ViewItem))
  ).toEqual([true, true, false, false]);
});

test('sessionMessageOutlineItems indexes only user messages against all rendered rows', () => {
  const items = [
    { id: 'u1', role: 'user', text: '  First\n question ', seq: '2026-08-07T09:00:00Z' },
    { id: 'tool1', kind: 'tool', tool: 'read', input: {}, status: 'done' },
    { id: 'a1', role: 'assistant', text: 'Answer' },
    { id: 'u2', role: 'user', text: '' }
  ] as ViewItem[];

  expect(sessionMessageOutlineItems(items, (number) => `Message ${number}`, formatTime)).toEqual([
    {
      id: 'u1',
      index: 0,
      label: 'First question',
      preview: '  First\n question ',
      time: 'at:2026-08-07T09:00:00Z'
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

test('completeSessionMessageOutlineItems keeps unloaded user messages navigable and appends optimistic ones', () => {
  const rendered = sessionMessageOutlineItems(
    [
      { id: 'msg_user_2', role: 'user', text: 'Second' },
      { id: 'msg_optimistic', role: 'user', text: 'Pending question' }
    ] as ViewItem[],
    (number) => `Message ${number}`,
    formatTime
  );

  expect(
    completeSessionMessageOutlineItems(
      [
        { id: 'msg_user_1', text: 'First', at: '2026-08-07T09:00:00Z' },
        { id: 'msg_user_2', text: 'Second' }
      ],
      rendered,
      (number) => `Message ${number}`,
      formatTime
    )
  ).toEqual([
    { id: 'msg_user_1', index: 0, label: 'First', preview: 'First', time: 'at:2026-08-07T09:00:00Z' },
    { id: 'msg_user_2', index: 1, label: 'Second', preview: 'Second', time: 'Time unavailable' },
    {
      id: 'msg_optimistic',
      index: 2,
      label: 'Pending question',
      preview: 'Pending question',
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
