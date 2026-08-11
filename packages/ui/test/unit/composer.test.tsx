import { expect, test } from 'bun:test';

import * as ComposerModule from '../../src/components/Composer';
import {
  composerEnterAction,
  composerKeyDownAction,
  LONG_PROMPT_CHARACTER_THRESHOLD,
  serializedTextToTiptapDoc,
  shouldSubmitComposerKey,
  tiptapDocToSerializedText
} from '../../src/components/ComposerEditor';

test('ComposerEditor leaves non-Enter shortcuts on the fast path', () => {
  let documentReads = 0;
  const readCurrentText = () => {
    documentReads += 1;
    return 'current composer text';
  };

  for (const key of ['c', 'v', 'k']) {
    expect(composerKeyDownAction({ key, primaryModifier: true, shiftKey: false }, 'enter', readCurrentText)).toBe(
      'ignore'
    );
  }
  expect(documentReads).toBe(0);
  expect(
    composerKeyDownAction({ key: 'Enter', primaryModifier: false, shiftKey: false }, 'enter', readCurrentText)
  ).toBe('submit');
  expect(documentReads).toBe(1);
});

test('composer model menu dimensions depend on the complete provider catalog', () => {
  const panelWidth = (
    ComposerModule as typeof ComposerModule & {
      composerModelMenuPanelWidth?: (provider: {
        label: string;
        models: Array<{ displayName?: string; label: string; value: string }>;
        value: string;
      }) => number;
    }
  ).composerModelMenuPanelWidth;
  const provider = {
    label: 'OpenRouter',
    models: [
      { displayName: 'GPT-5', label: 'gpt-5', value: 'gpt-5' },
      {
        displayName: 'Google: Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)',
        label: 'google-image',
        value: 'google-image'
      }
    ],
    value: 'openrouter'
  };

  expect(panelWidth?.(provider)).toBe(352);
  expect(panelWidth?.({ ...provider, models: provider.models.slice(0, 1) })).toBe(256);
});

test('composer model menu groups models under configured providers', () => {
  const sections = (
    ComposerModule as typeof ComposerModule & {
      buildComposerModelMenuSections?: (model: {
        currentModel?: string;
        currentProvider?: string;
        providers: Array<{
          label: string;
          models: Array<{ displayName?: string; label: string; value: string }>;
          value: string;
        }>;
      }) => unknown;
    }
  ).buildComposerModelMenuSections?.({
    currentModel: 'gpt-5',
    currentProvider: 'openai',
    providers: [
      {
        label: 'OpenAI',
        models: [
          { displayName: 'GPT-5', label: 'gpt-5', value: 'gpt-5' },
          { label: 'gpt-4.1', value: 'gpt-4.1' }
        ],
        value: 'openai'
      },
      {
        label: 'Anthropic',
        models: [{ displayName: 'Claude Sonnet', label: 'sonnet', value: 'sonnet' }],
        value: 'anthropic'
      }
    ]
  });

  expect(sections).toEqual([
    {
      label: 'OpenAI',
      models: [
        { label: 'GPT-5', selected: true, value: 'gpt-5' },
        { label: 'gpt-4.1', selected: false, value: 'gpt-4.1' }
      ],
      selected: true,
      value: 'openai'
    },
    {
      label: 'Anthropic',
      models: [{ label: 'Claude Sonnet', selected: false, value: 'sonnet' }],
      selected: false,
      value: 'anthropic'
    }
  ]);
});

test('composer model menu hover state keeps only the active provider open', () => {
  const hoverState = (
    ComposerModule as typeof ComposerModule & {
      composerModelMenuHoverState?: (target: { kind: 'profile' | 'provider'; provider?: string }) => {
        openProvider?: string;
      };
    }
  ).composerModelMenuHoverState;

  expect(hoverState?.({ kind: 'provider', provider: 'openai' })).toEqual({ openProvider: 'openai' });
  expect(hoverState?.({ kind: 'profile' })).toEqual({ openProvider: undefined });
});

test('ComposerEditor send shortcut treats multiline and long prompts as modifier-send prompts', () => {
  expect(
    shouldSubmitComposerKey(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD - 1,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
  expect(
    shouldSubmitComposerKey(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe(false);
  expect(
    shouldSubmitComposerKey(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: true,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
  expect(
    shouldSubmitComposerKey(
      { characterCount: 4, hasMultipleLines: true, key: 'Enter', primaryModifier: true, shiftKey: false },
      'mod-enter-for-multiline'
    )
  ).toBe(true);
});

test('ComposerEditor inserts visible line breaks whenever Enter is not the configured submit gesture', () => {
  expect(
    composerEnterAction(
      { characterCount: 4, hasMultipleLines: false, key: 'Enter', primaryModifier: false, shiftKey: true },
      'enter'
    )
  ).toBe('line-break');
  expect(
    composerEnterAction(
      {
        characterCount: LONG_PROMPT_CHARACTER_THRESHOLD,
        hasMultipleLines: false,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'mod-enter-for-multiline'
    )
  ).toBe('line-break');
  expect(
    composerEnterAction(
      { characterCount: 4, hasMultipleLines: false, key: 'Enter', primaryModifier: false, shiftKey: false },
      'mod-enter-always'
    )
  ).toBe('line-break');
  expect(
    composerEnterAction(
      { characterCount: 4, hasMultipleLines: false, key: 'Enter', primaryModifier: true, shiftKey: false },
      'mod-enter-always'
    )
  ).toBe('submit');
});

test('ComposerEditor leaves Enter to the ordered-list keymap so it creates the next item', () => {
  expect(
    composerKeyDownAction(
      {
        inOrderedList: true,
        key: 'Enter',
        primaryModifier: false,
        shiftKey: false
      },
      'enter',
      () => '1. First'
    )
  ).toBe('list-item');
});

test('ComposerEditor parses numbered lines and indented continuations into an ordered list', () => {
  expect(serializedTextToTiptapDoc('Before\n3. First\n   continuation\n4. Second\nAfter')).toEqual({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Before' }]
      },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'First' },
                  { type: 'hardBreak' },
                  { type: 'text', text: 'continuation' }
                ]
              }
            ]
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Second' }]
              }
            ]
          }
        ]
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'After' }]
      }
    ]
  });
});

test('ComposerEditor serializes ordered lists and continuations with visible numbering for sending and clipboard text', () => {
  expect(
    tiptapDocToSerializedText({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'First' },
                    { type: 'hardBreak' },
                    { type: 'text', text: 'continuation' }
                  ]
                }
              ]
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Second' }]
                }
              ]
            }
          ]
        }
      ]
    })
  ).toBe('3. First\n   continuation\n4. Second');
});
