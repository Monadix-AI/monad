import { expect, test } from 'bun:test';

import { primaryModifierPressed, shortcutNumberFromEvent } from '../../src/lib/keyboard.ts';

test('shortcutNumberFromEvent reads 1-9 from the key, ignoring 0 and non-digits', () => {
  expect(shortcutNumberFromEvent({ key: '3', code: 'Digit3' } as KeyboardEvent)).toBe(3);
});

test('shortcutNumberFromEvent falls back to the physical code (e.g. option-key layouts, numpad)', () => {
  expect(shortcutNumberFromEvent({ key: '≤', code: 'Digit5' } as KeyboardEvent)).toBe(5);
  expect(shortcutNumberFromEvent({ key: 'Dead', code: 'Numpad7' } as KeyboardEvent)).toBe(7);
});

test('primaryModifierPressed reads meta on Apple and ctrl elsewhere', () => {
  expect(primaryModifierPressed({ metaKey: true, ctrlKey: false } as KeyboardEvent, true)).toBe(true);
  expect(primaryModifierPressed({ metaKey: true, ctrlKey: false } as KeyboardEvent, false)).toBe(false);
  expect(primaryModifierPressed({ metaKey: false, ctrlKey: true } as KeyboardEvent, false)).toBe(true);
});
