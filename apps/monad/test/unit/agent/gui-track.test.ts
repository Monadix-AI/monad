import { expect, test } from 'bun:test';

import { guiTrackInstructions } from '@/agent/prompts.ts';

test('no GUI tools → no hint', () => {
  expect(guiTrackInstructions(['file_read', 'shell_exec'])).toBe('');
});

test('both tracks present → choose-deliberately guidance favouring the browser', () => {
  const _hint = guiTrackInstructions(['browser__navigate', 'computer__click_screen', 'file_read']);
});

test('computer only → real-desktop caution + untrusted on-screen text', () => {
  const _hint = guiTrackInstructions(['computer__take_screenshot', 'computer__type_text']);
});

test('browser only → browser usage hint', () => {
  const _hint = guiTrackInstructions(['browser__snapshot', 'browser__click']);
});
