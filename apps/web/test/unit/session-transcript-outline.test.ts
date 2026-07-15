import type { ViewItem } from '../../src/features/session/chat-view-items';

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { SESSION_TRANSCRIPT_CONTENT_CLASS } from '../../src/features/session/SessionTranscript';
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

test('session transcript content width includes its horizontal padding', () => {
  expect(SESSION_TRANSCRIPT_CONTENT_CLASS).toBe('mx-auto box-border w-full max-w-[900px] px-6');

  const composerSource = readFileSync(
    new URL('../../src/features/session/SessionComposerRegion.tsx', import.meta.url),
    'utf8'
  );
  expect(composerSource).toContain('SESSION_CONTENT_CLASS');
  expect(composerSource).not.toContain('max-w-4xl');
});
