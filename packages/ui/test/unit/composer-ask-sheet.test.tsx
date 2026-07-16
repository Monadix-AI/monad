import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ComposerAskSheet, composerAskSheetKeyAction } from '../../src/components/ComposerAskSheet';

test('ComposerAskSheet uses an opaque themed surface', () => {
  const markup = renderToStaticMarkup(
    <ComposerAskSheet
      askedLabel="asked"
      asker={<span>Codex</span>}
      buildAnswer={(selected) => selected[0] ?? null}
      dismissLabel="Dismiss"
      onAnswer={() => {}}
      onDismiss={() => {}}
      otherAriaLabel="Other"
      otherPlaceholder="Other answer"
      position={1}
      question={{ id: 'clarify_1', mode: 'single', options: ['Ship'], question: 'Proceed?' }}
      submitLabel="Submit"
      total={1}
    />
  );

  expect(markup).toContain('background:var(--popover)');
});

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
