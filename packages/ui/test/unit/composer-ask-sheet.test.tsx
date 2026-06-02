import { expect, test } from 'bun:test';

import { composerAskSheetKeyAction } from '../../src/components/ComposerAskSheet';

test('ComposerAskSheet maps scoped keyboard shortcuts to explicit actions', () => {
  expect([
    composerAskSheetKeyAction({
      inTextInput: false,
      isComposing: false,
      key: '1',
      primaryModifier: false
    }),
    composerAskSheetKeyAction({
      inTextInput: false,
      isComposing: false,
      key: 'ArrowDown',
      primaryModifier: false
    }),
    composerAskSheetKeyAction({
      inTextInput: false,
      isComposing: false,
      key: 'ArrowUp',
      primaryModifier: false
    }),
    composerAskSheetKeyAction({
      inTextInput: false,
      isComposing: false,
      key: ' ',
      primaryModifier: false
    }),
    composerAskSheetKeyAction({
      inTextInput: false,
      isComposing: false,
      key: 'Enter',
      primaryModifier: false
    }),
    composerAskSheetKeyAction({
      inTextInput: true,
      isComposing: false,
      key: 'Enter',
      primaryModifier: true
    }),
    composerAskSheetKeyAction({
      inTextInput: true,
      isComposing: false,
      key: 'Escape',
      primaryModifier: false
    })
  ]).toEqual([
    { type: 'choose', index: 0 },
    { type: 'focus-next' },
    { type: 'focus-previous' },
    { type: 'toggle-active' },
    { type: 'submit' },
    { type: 'submit' },
    { type: 'dismiss' }
  ]);
});
