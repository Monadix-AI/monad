import { expect, test } from 'bun:test';

import {
  composerShortcutLabel,
  DEFAULT_COMPOSER_SETTINGS,
  queuedCardsForDisplay,
  shouldSubmitComposerKey
} from '../../lib/composer-settings';

test('composer settings default to Enter send and queued follow-ups', () => {
  expect(DEFAULT_COMPOSER_SETTINGS).toEqual({
    followUpBehavior: 'queue',
    sendShortcut: 'enter'
  });
});

test('composerShortcutLabel uses platform primary modifier names', () => {
  expect(composerShortcutLabel('mod-enter-for-multiline', true)).toBe('⌘ + Enter for long prompts');
  expect(composerShortcutLabel('mod-enter-always', false)).toBe('Ctrl + Enter always');
});

test('shouldSubmitComposerKey supports Enter send mode', () => {
  expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, primaryModifier: false }, 'enter')).toBe(true);
  expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: true, primaryModifier: false }, 'enter')).toBe(false);
});

test('shouldSubmitComposerKey supports primary-modifier multiline mode', () => {
  expect(
    shouldSubmitComposerKey(
      { hasMultipleLines: false, key: 'Enter', shiftKey: false, primaryModifier: false },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
  expect(
    shouldSubmitComposerKey(
      { hasMultipleLines: true, key: 'Enter', shiftKey: false, primaryModifier: false },
      'mod-enter-for-multiline'
    )
  ).toBe(false);
  expect(
    shouldSubmitComposerKey(
      { hasMultipleLines: true, key: 'Enter', shiftKey: false, primaryModifier: true },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
});

test('shouldSubmitComposerKey supports primary-modifier send mode', () => {
  expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, primaryModifier: false }, 'mod-enter-always')).toBe(
    false
  );
  expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, primaryModifier: true }, 'mod-enter-always')).toBe(
    true
  );
});

test('queuedCardsForDisplay shows at most the latest two queued messages newest first', () => {
  expect(queuedCardsForDisplay(['first', 'second', 'third'])).toEqual([
    { displayIndex: 0, queueIndex: 2, text: 'third' },
    { displayIndex: 1, queueIndex: 1, text: 'second' }
  ]);
});
