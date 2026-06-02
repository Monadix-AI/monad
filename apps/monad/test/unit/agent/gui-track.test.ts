import { expect, test } from 'bun:test';

import { guiTrackInstructions } from '@/agent/prompts.ts';

test('no GUI tools → no hint', () => {
  expect(guiTrackInstructions(['fs_read', 'shell_exec'])).toBe('');
});

test('both tracks present → choose-deliberately guidance favouring the browser', () => {
  const hint = guiTrackInstructions(['browser__navigate', 'computer__click_screen', 'fs_read']);
  expect(hint).toContain('browser');
  expect(hint).toContain('computer');
  expect(hint.toLowerCase()).toContain('default to the browser');
});

test('computer only → real-desktop caution + untrusted on-screen text', () => {
  const hint = guiTrackInstructions(['computer__take_screenshot', 'computer__type_text']);
  expect(hint).toContain('REAL desktop');
  expect(hint.toLowerCase()).toContain('untrusted');
});

test('browser only → browser usage hint', () => {
  const hint = guiTrackInstructions(['browser__snapshot', 'browser__click']);
  expect(hint).toContain('browser');
  expect(hint).not.toContain('REAL desktop');
});
